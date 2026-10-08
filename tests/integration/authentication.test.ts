import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { createTokenVerifier } from '@j-auth/token-verifier';
import { CLIENT_IDS } from '@j-auth/contracts';
import { createApp } from '../../apps/server/src/app.js';
import { RealmCredentials } from '../../apps/server/src/keycloak/client.js';
import { createAuthorizer } from '../../apps/server/src/security/authorize.js';
import { integrationRuntime, requiredTestEnv } from './runtime.js';
import type { IntegrationRuntime } from './runtime.js';

describe('real Keycloak and j-auth HTTPS authentication', () => {
  let runtime: IntegrationRuntime;
  let app: ReturnType<typeof createApp>;
  let aToken: string;
  let bToken: string;
  let cToken: string;
  let memberToken: string;
  let operatorToken: string;
  const appUrl = 'https://jauth.jgw.test:54231';
  beforeAll(async () => {
    runtime = await integrationRuntime();
    aToken = (await runtime.passwordToken('sample-a', 'a-admin')).access_token;
    bToken = (await runtime.passwordToken('sample-b', 'b-admin')).access_token;
    cToken = (await runtime.passwordToken('sample-c', 'c-admin')).access_token;
    memberToken = (await runtime.passwordToken('sample-a', 'a-member'))
      .access_token;
    operatorToken = (await runtime.passwordToken('operator', 'op-admin'))
      .access_token;
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
  });
  afterAll(async () => {
    if (app) await app.close();
    if (runtime) await runtime.close();
  });
  const api = async (token?: string, key?: string) =>
    await runtime.fetch(`${appUrl}/auth/members/grantable-roles`, {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(key ? { 'X-JGW-Service-Key': key } : {}),
      },
    });

  it('serves real HTTPS liveness/readiness with private responses', async () => {
    const result = await runtime.fetch(`${appUrl}/health/ready`);
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(await result.json()).toEqual({ status: 'ok' });
  });
  it('allows the registered admin only with its own service key', async () => {
    const result = await api(
      aToken,
      requiredTestEnv('JGW_SAMPLE_A_SERVICE_KEY'),
    );
    expect(result.status).toBe(200);
    const data = (await result.json()) as { roles: string[] };
    expect(data.roles).toContain('mail:read');
    expect(data.roles).toContain('board:write');
    expect(data.roles).not.toContain('member:manage');
    expect(data.roles).not.toContain('tenant:admin');
    const minimal = await api(
      cToken,
      requiredTestEnv('JGW_SAMPLE_C_SERVICE_KEY'),
    );
    expect(minimal.status).toBe(200);
    expect(((await minimal.json()) as { roles: string[] }).roles).toEqual([
      'board:read',
      'board:write',
      'org:manage',
    ]);
  });
  it('rejects missing credentials, mixed tenant keys and the console realm', async () => {
    expect((await api()).status).toBe(401);
    expect((await api(aToken)).status).toBe(401);
    expect(
      (await api(aToken, requiredTestEnv('JGW_SAMPLE_B_SERVICE_KEY'))).status,
    ).toBe(401);
    expect(
      (await api(bToken, requiredTestEnv('JGW_SAMPLE_A_SERVICE_KEY'))).status,
    ).toBe(401);
    expect(
      (await api(operatorToken, requiredTestEnv('JAUTH_CONSOLE_SERVICE_KEY')))
        .status,
    ).toBe(401);
    const denied = await api(
      memberToken,
      requiredTestEnv('JGW_SAMPLE_A_SERVICE_KEY'),
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      code: 'forbidden',
      requestId: expect.any(String),
    });
  });
  it('uses the console audience and key only for operator authorization', async () => {
    const authorize = createAuthorizer({
      tenants: runtime.tenants,
      verifier: createTokenVerifier({
        publicUrl: runtime.publicUrl,
        fetch: runtime.fetch,
      }),
      consoleKeyHashes: [requiredTestEnv('JAUTH_CONSOLE_KEY_HASH')],
    });
    expect(
      (
        await authorize(
          {
            authorization: `Bearer ${operatorToken}`,
            serviceKey: requiredTestEnv('JAUTH_CONSOLE_SERVICE_KEY'),
          },
          'operator',
        )
      ).tenantId,
    ).toBe('operator');
    await expect(
      authorize(
        {
          authorization: `Bearer ${aToken}`,
          serviceKey: requiredTestEnv('JAUTH_CONSOLE_SERVICE_KEY'),
        },
        'operator',
      ),
    ).rejects.toMatchObject({ statusCode: 401 });
  });
  it('rejects forged tenant routing before requesting an unregistered realm JWKS', async () => {
    const parts = aToken.split('.');
    parts[1] = Buffer.from(
      JSON.stringify({ ...decodeJwt(aToken), tenant: 'unknown-customer' }),
    ).toString('base64url');
    const result = await api(
      parts.join('.'),
      requiredTestEnv('JGW_SAMPLE_A_SERVICE_KEY'),
    );
    expect(result.status).toBe(401);
    expect(JSON.stringify(await result.json())).not.toContain(
      requiredTestEnv('JGW_SAMPLE_A_SERVICE_KEY'),
    );
  });
  it('rejects a real token for a wrong receiving audience and excludes optional sample-c audiences', async () => {
    const verifier = createTokenVerifier({
      publicUrl: runtime.publicUrl,
      fetch: runtime.fetch,
    });
    await expect(
      verifier.verify(aToken, {
        tenantId: 'sample-a',
        audience: 'unsubscribed-service',
      }),
    ).rejects.toMatchObject({ kind: 'invalid' });
    await expect(
      verifier.verify(cToken, { tenantId: 'sample-c', audience: 'j-mail' }),
    ).rejects.toMatchObject({ kind: 'invalid' });
    expect(
      (
        await verifier.verify(aToken, {
          tenantId: 'sample-a',
          audience: 'j-mail',
        })
      ).roles,
    ).toContain('mail:read');
  });
  it('caches real JWKS and reloads after a new Keycloak signing kid', async () => {
    let reads = 0;
    const tracked: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/certs')) reads++;
      return await runtime.fetch(input, init);
    };
    const verifier = createTokenVerifier({
      publicUrl: runtime.publicUrl,
      fetch: tracked,
    });
    await verifier.verify(aToken, {
      tenantId: 'sample-a',
      audience: 'j-groupware',
    });
    await verifier.verify(aToken, {
      tenantId: 'sample-a',
      audience: 'j-groupware',
    });
    expect(reads).toBe(1);
    const realm = await runtime.json<{ id: string }>(
      '/admin/realms/tenant-sample-a',
    );
    const response = await runtime.admin(
      '/admin/realms/tenant-sample-a/components',
      {
        method: 'POST',
        body: JSON.stringify({
          name: `integration-rsa-${randomUUID()}`,
          providerId: 'rsa-generated',
          providerType: 'org.keycloak.keys.KeyProvider',
          parentId: realm.id,
          config: {
            priority: ['200'],
            enabled: ['true'],
            active: ['true'],
            algorithm: ['RS256'],
            keySize: ['2048'],
          },
        }),
      },
    );
    expect(response.status).toBe(201);
    const location = new URL(response.headers.get('location')!).pathname;
    try {
      const rotated = (await runtime.passwordToken('sample-a', 'a-admin'))
        .access_token;
      expect(decodeProtectedHeader(rotated).kid).not.toBe(
        decodeProtectedHeader(aToken).kid,
      );
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await verifier.verify(rotated, {
        tenantId: 'sample-a',
        audience: 'j-groupware',
      });
      expect(reads).toBe(2);
    } finally {
      expect((await runtime.admin(location, { method: 'DELETE' })).status).toBe(
        204,
      );
    }
  });
  it('reads realm credentials with master access and keeps them out of tenant DB records', async () => {
    const credentials = new RealmCredentials({
      master: runtime.master,
      tenants: runtime.tenants,
      baseUrl: runtime.publicUrl,
      fetch: runtime.fetch,
    });
    const [admin, provisioner] = await Promise.all([
      credentials.secret('sample-a', CLIENT_IDS.memberAdmin),
      credentials.secret('sample-a', CLIENT_IDS.provisioner),
    ]);
    expect(
      admin === requiredTestEnv('JGW_SAMPLE_A_J_AUTH_ADMIN_CLIENT_SECRET'),
    ).toBe(true);
    expect(
      provisioner ===
        requiredTestEnv('JGW_SAMPLE_A_J_AUTH_PROVISIONER_CLIENT_SECRET'),
    ).toBe(true);
    const tables = await runtime.pool.query('SELECT * FROM tenants');
    expect(JSON.stringify(tables.rows)).not.toContain(admin);
    expect(JSON.stringify(tables.rows)).not.toContain(provisioner);
    credentials.invalidate('sample-a');
    expect(
      (await credentials.secret('sample-a', CLIENT_IDS.memberAdmin)) === admin,
    ).toBe(true);
  });
  it('returns service unavailable when real JWKS transport is disconnected', async () => {
    const verifier = createTokenVerifier({
      publicUrl: 'https://auth.jgw.test:59999',
      fetch: runtime.fetch,
    });
    await expect(
      verifier.verify(aToken, {
        tenantId: 'sample-a',
        audience: 'j-groupware',
      }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
  });
  it('exchanges a real token down to one subscribed service audience', async () => {
    const exchange = async (tenant: string, token: string) =>
      await runtime.fetch(
        `${runtime.publicUrl}/realms/tenant-${tenant}/protocol/openid-connect/token`,
        {
          method: 'POST',
          body: new URLSearchParams({
            client_id: 'j-groupware',
            client_secret: requiredTestEnv(
              `JGW_${tenant.toUpperCase().replaceAll('-', '_')}_J_GROUPWARE_CLIENT_SECRET`,
            ),
            grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
            subject_token: token,
            subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
            requested_token_type:
              'urn:ietf:params:oauth:token-type:access_token',
            audience: 'j-mail',
          }),
        },
      );
    const response = await exchange('sample-a', aToken);
    expect(response.status).toBe(200);
    const exchanged = ((await response.json()) as { access_token: string })
      .access_token;
    expect(decodeJwt(exchanged).aud).toBe('j-mail');
    const verifier = createTokenVerifier({
      publicUrl: runtime.publicUrl,
      fetch: runtime.fetch,
    });
    expect(
      (
        await verifier.verify(exchanged, {
          tenantId: 'sample-a',
          audience: 'j-mail',
        })
      ).roles,
    ).toContain('mail:read');
    await expect(
      verifier.verify(exchanged, {
        tenantId: 'sample-a',
        audience: 'j-groupware',
      }),
    ).rejects.toMatchObject({ kind: 'invalid' });
    expect((await exchange('sample-c', cToken)).status).toBe(400);
  });
  it('rotates refresh tokens and ends the session when a used token is replayed', async () => {
    const session = await runtime.passwordToken('sample-a', 'a-admin');
    const refresh = async (token: string) =>
      await runtime.fetch(
        `${runtime.publicUrl}/realms/tenant-sample-a/protocol/openid-connect/token`,
        {
          method: 'POST',
          body: new URLSearchParams({
            client_id: 'j-groupware',
            client_secret: requiredTestEnv(
              'JGW_SAMPLE_A_J_GROUPWARE_CLIENT_SECRET',
            ),
            grant_type: 'refresh_token',
            refresh_token: token,
          }),
        },
      );
    const changed = await refresh(session.refresh_token);
    expect(changed.status).toBe(200);
    const next = (await changed.json()) as { refresh_token: string };
    expect(next.refresh_token === session.refresh_token).toBe(false);
    expect((await refresh(session.refresh_token)).status).toBe(400);
    expect((await refresh(next.refresh_token)).status).toBe(400);
  });
});
