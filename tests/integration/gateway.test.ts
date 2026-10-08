import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtemp,
  writeFile,
  readFile,
  copyFile,
  chmod,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { decodeJwt } from 'jose';
import { renderAuthGateway } from '../../deploy/gateway/gateway.mjs';
import { createApp } from '../../apps/server/src/app.js';
import { createTokenVerifier } from '@j-auth/token-verifier';
import { RealmCredentials } from '../../apps/server/src/keycloak/client.js';
import { integrationRuntime, requiredTestEnv } from './runtime.js';
import type { IntegrationRuntime } from './runtime.js';
const execute = promisify(execFile);
const image =
  'nginx@sha256:9bf97bd7714f5e24c1ccd545ecb9eb5435cb6d109c97cebb15e7e455e0239edb';
async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const p = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
  return p;
}
describe('auth control-plane actual Nginx allowlist', () => {
  let runtime: IntegrationRuntime,
    app: ReturnType<typeof createApp>,
    root = '',
    name = '',
    origin = '';
  const marker = 'not-logged-' + randomUUID();
  let profile: Record<string, unknown>;
  beforeAll(async () => {
    runtime = await integrationRuntime();
    root = await mkdtemp(path.join(tmpdir(), 'jauth-gateway-'));
    name = 'jauth-gateway-' + randomUUID();
    app = createApp({
      pool: runtime.pool,
      verifier: createTokenVerifier({
        publicUrl: runtime.publicUrl,
        fetch: runtime.fetch,
      }),
      consoleKeyHashes: [requiredTestEnv('JAUTH_CONSOLE_KEY_HASH')],
      credentials: new RealmCredentials({
        master: runtime.master,
        tenants: runtime.tenants,
        baseUrl: runtime.publicUrl,
        fetch: runtime.fetch,
      }),
      https: {
        cert: await readFile(requiredTestEnv('JAUTH_TLS_CERTIFICATE')),
        key: await readFile(requiredTestEnv('JAUTH_TLS_KEY')),
      },
    });
    await app.listen({ host: '127.0.0.1', port: 54231 });
    const port = await availablePort();
    origin = `https://auth.jgw.test:${port}`;
    await copyFile(
      requiredTestEnv('JAUTH_TLS_CERTIFICATE'),
      path.join(root, 'certificate.pem'),
    );
    await copyFile(
      requiredTestEnv('JAUTH_TLS_KEY'),
      path.join(root, 'private.pem'),
    );
    await chmod(path.join(root, 'private.pem'), 0o600);
    profile = {
      root,
      hostname: 'auth.jgw.test',
      listenPort: port,
      certificate: path.join(root, 'certificate.pem'),
      privateKey: path.join(root, 'private.pem'),
      upstreamCa: path.join(root, 'certificate.pem'),
      keycloakPort: Number(new URL(runtime.publicUrl).port),
      keycloakTlsName: 'auth.jgw.test',
      authPort: 54231,
      authTlsName: 'jauth.jgw.test',
      loginRate: 100,
      loginBurst: 100,
    };
    await writeFile(path.join(root, 'nginx.conf'), renderAuthGateway(profile), {
      mode: 0o600,
    });
    await execute('docker', ['image', 'inspect', image], { timeout: 10000 });
    await execute(
      'docker',
      [
        'run',
        '--detach',
        '--name',
        name,
        '--network',
        'host',
        '--user',
        `${process.getuid!()}:${process.getgid!()}`,
        '--read-only',
        '--cap-drop=ALL',
        '--mount',
        `type=bind,source=${root},target=${root}`,
        image,
        'nginx',
        '-c',
        path.join(root, 'nginx.conf'),
        '-g',
        'daemon off;',
      ],
      { timeout: 15000 },
    );
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        ready =
          (
            await runtime.fetch(
              origin + '/realms/tenant-sample-a/protocol/openid-connect/certs',
              { signal: AbortSignal.timeout(1000) },
            )
          ).status === 200;
      } catch {}
      if (ready) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(ready).toBe(true);
  });
  afterAll(async () => {
    if (name)
      await execute('docker', ['rm', '--force', name], {
        timeout: 10000,
      }).catch(() => {});
    if (app) await app.close();
    if (runtime) await runtime.close();
    if (root) await rm(root, { recursive: true, force: true });
  });
  it('forwards actual discovery, JWKS, login/logout, theme/login-actions and j-auth API routes', async () => {
    const discovery = await runtime.fetch(
      origin + '/realms/tenant-sample-a/.well-known/openid-configuration',
    );
    expect(discovery.status).toBe(200);
    expect(((await discovery.json()) as { issuer: string }).issuer).toBe(
      runtime.publicUrl + '/realms/tenant-sample-a',
    );
    const certs = await runtime.fetch(
      origin + '/realms/tenant-sample-a/protocol/openid-connect/certs',
    );
    expect(certs.status).toBe(200);
    expect(
      ((await certs.json()) as { keys: unknown[] }).keys.length,
    ).toBeGreaterThan(0);
    for (const url of [
      '/realms/tenant-sample-a/protocol/openid-connect/auth',
      '/realms/tenant-sample-a/protocol/openid-connect/logout',
      '/realms/tenant-sample-a/login-actions/fixture',
      '/resources/fixture',
    ])
      await (
        await runtime.fetch(origin + url, { redirect: 'manual' })
      ).arrayBuffer();
    const token = (await runtime.passwordToken('sample-a', 'a-admin'))
      .access_token;
    const allowed = await runtime.fetch(
      origin + '/auth/members/grantable-roles',
      {
        headers: {
          Authorization: 'Bearer ' + token,
          'X-JGW-Service-Key': requiredTestEnv('JGW_SAMPLE_A_SERVICE_KEY'),
        },
      },
    );
    expect(allowed.status).toBe(200);
    expect(
      (
        await runtime.fetch(origin + '/auth/members/grantable-roles', {
          headers: {
            Authorization: 'Bearer ' + token,
            'X-JGW-Service-Key': requiredTestEnv('JGW_SAMPLE_B_SERVICE_KEY'),
          },
        })
      ).status,
    ).toBe(401);
    const access = await readFile(path.join(root, 'access.log'), 'utf8');
    for (const prefix of [
      'GET /resources/fixture',
      'GET /realms/tenant-sample-a/login-actions/fixture',
      'GET /realms/tenant-sample-a/protocol/openid-connect/auth',
      'GET /realms/tenant-sample-a/protocol/openid-connect/logout',
    ])
      expect(
        access.split('\n').find((line) => line.startsWith(prefix)),
      ).toMatch(/ [0-9]{3} [0-9]{3}$/);
  });
  it('obtains a real signed token through the fixed token route without exposing management paths', async () => {
    const response = await runtime.fetch(
      origin + '/realms/tenant-sample-a/protocol/openid-connect/token',
      {
        method: 'POST',
        body: new URLSearchParams({
          client_id: 'j-groupware',
          client_secret: requiredTestEnv(
            'JGW_SAMPLE_A_J_GROUPWARE_CLIENT_SECRET',
          ),
          grant_type: 'password',
          username: 'a-admin',
          password: requiredTestEnv('JGW_SAMPLE_A_A_ADMIN_PASSWORD'),
        }),
      },
    );
    expect(response.status).toBe(200);
    const value = (await response.json()) as { access_token: string };
    expect(decodeJwt(value.access_token).tenant).toBe('sample-a');
    for (const url of [
      '/admin',
      '/admin/realms',
      '/realms/tenant-sample-a/account',
      '/realms/tenant-sample-a/account/',
      '/health',
      '/health/ready',
      '/metrics',
      '/realms/tenant-sample-a/protocol/openid-connect/userinfo',
      '/realms/tenant-sample-a/protocol/openid-connect/token/',
      '/realms/tenant-sample-a/protocol/openid-connect/revoke',
      '/realms/tenant-sample-a/.well-known/openid-configuration/',
    ])
      expect(
        (await runtime.fetch(origin + url, { redirect: 'manual' })).status,
      ).toBe(404);
    expect(
      (await runtime.fetch(origin + '/admin?secret=' + marker)).status,
    ).toBe(404);
    const access = await readFile(path.join(root, 'access.log'), 'utf8');
    expect(access).toContain('GET /admin 404 -');
    expect(access).not.toContain(marker);
    expect(access).not.toContain(value.access_token);
  });
  it('rate limits requests from the actual source IP and suppresses query/credential logging', async () => {
    await writeFile(
      path.join(root, 'nginx.conf'),
      renderAuthGateway({ ...profile, loginRate: 1, loginBurst: 1 }),
      { mode: 0o600 },
    );
    await execute(
      'docker',
      [
        'exec',
        name,
        'nginx',
        '-c',
        path.join(root, 'nginx.conf'),
        '-s',
        'reload',
      ],
      { timeout: 10000 },
    );
    await new Promise((r) => setTimeout(r, 150));
    const statuses = await Promise.all(
      Array.from(
        { length: 20 },
        async () =>
          (
            await runtime.fetch(
              origin +
                '/realms/tenant-sample-a/protocol/openid-connect/token?secret=' +
                marker,
              {
                method: 'POST',
                headers: {
                  'X-Forwarded-For':
                    '192.0.2.' + Math.ceil(Math.random() * 200),
                },
                body: new URLSearchParams({
                  client_id: 'not-a-client',
                  grant_type: 'password',
                  password: marker,
                }),
              },
            )
          ).status,
      ),
    );
    expect(statuses).toContain(429);
    expect(statuses.every((s) => [400, 401, 429].includes(s))).toBe(true);
    expect(await readFile(path.join(root, 'access.log'), 'utf8')).not.toContain(
      marker,
    );
    expect(await readFile(path.join(root, 'error.log'), 'utf8')).not.toContain(
      marker,
    );
  });
  it('rejects config injection, unsupported keys, duplicate/reserved ports and path traversal', () => {
    for (const patch of [
      { hostname: 'auth.jgw.test; include /tmp/x;' },
      { root: root + '/../outside' },
      { listenPort: 3001 },
      { authPort: profile.keycloakPort },
      { extra: 'secret' },
      { certificate: '/tmp/key;abc' },
      { loginRate: 0 },
    ])
      expect(() => renderAuthGateway({ ...profile, ...patch })).toThrow(
        'Invalid auth gateway profile',
      );
  });
});
