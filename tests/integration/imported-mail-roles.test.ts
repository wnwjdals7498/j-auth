import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { Agent, fetch as undiciFetch } from 'undici';
import { Pool } from 'pg';
import { SERVICE_CATALOG } from '@j-auth/contracts';
import { createTokenVerifier } from '@j-auth/token-verifier';
import { authorizationCodeLogin } from './oidc-code.js';
import { createApp } from '../../apps/server/src/app.js';
import { loadServerConfig } from '../../apps/server/src/config.js';
import { TenantStore } from '../../apps/server/src/db/tenants.js';
import {
  KeycloakClient,
  RealmCredentials,
} from '../../apps/server/src/keycloak/client.js';
import { configureMemberAdmin } from '../../apps/server/src/keycloak/admin-permissions.js';
import {
  customerTemplate,
  snapshotClients,
} from '../../apps/server/src/keycloak/realm-model.js';
import { generateServiceKey } from '../../apps/server/src/security/service-key.js';
import { requiredTestEnv } from './runtime.js';
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
interface KcRole {
  id: string;
  name: string;
  containerId: string;
}
interface KcClient {
  id: string;
  clientId: string;
}
describe('existing imported aliases and corrected import with unchanged sample permissions', () => {
  let pool: Pool,
    store: TenantStore,
    master: KeycloakClient,
    credentials: RealmCredentials,
    app: ReturnType<typeof createApp>,
    agent: Agent,
    fetch: typeof globalThis.fetch,
    admin = '',
    existingPolicy = '',
    existingRoleCatalog = '';
  const ownedMembers = new Map<string, string>(),
    ownedTenants = new Set<string>(),
    report: Record<string, unknown> = {};
  let memberId = '',
    memberUsername = '',
    memberPassword = '',
    canonical: KcRole,
    alias: KcRole,
    mailClient: KcClient,
    loginClient: KcClient;
  const read = async <T>(path: string): Promise<T> => {
    const r = await master.request(path);
    if (!r.ok) throw new Error(`Readonly fixture query failed (${r.status}).`);
    return (await r.json()) as T;
  };
  const permissions = async () => {
    const clients = await read<KcClient[]>(
        '/admin/realms/tenant-sample-a/clients',
      ),
      p = clients.find((c) => c.clientId === 'admin-permissions')!,
      base =
        '/admin/realms/tenant-sample-a/clients/' +
        p.id +
        '/authz/resource-server';
    const policies = await read<{ id: string; name: string }[]>(
        base + '/policy?first=0&max=1000',
      ),
      rows = [];
    for (const p of policies
      .filter((p) => p.name.startsWith('j-auth-admin-'))
      .sort((a, b) => a.name.localeCompare(b.name)))
      rows.push({
        policy: await read(base + '/policy/' + p.id),
        resources: await read(base + '/policy/' + p.id + '/resources'),
        scopes: await read(base + '/policy/' + p.id + '/scopes'),
        associated: await read(
          base + '/policy/' + p.id + '/associatedPolicies',
        ),
      });
    return digest(rows);
  };
  const catalog = async () => digest(await snapshotClients(master, 'sample-a'));
  const request = async (path: string, method = 'GET', body?: unknown) =>
    fetch('https://jauth.jgw.test:54231' + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + admin,
        'X-JGW-Service-Key': requiredTestEnv('JGW_SAMPLE_A_SERVICE_KEY'),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const candidate = () => {
    const username = 'compat-' + randomUUID();
    ownedMembers.set(username, '');
    return {
      username,
      password: randomBytes(24).toString('base64url'),
      roles: ['mail:read'],
    };
  };
  beforeAll(async () => {
    if (requiredTestEnv('JAUTH_TEST_RUNTIME') !== 'isolated-cloud')
      throw new Error('Isolated fixtures required. No skip.');
    const c = loadServerConfig(),
      cert = await readFile(c.tlsCertificate),
      key = await readFile(c.tlsKey);
    agent = new Agent({
      connect: {
        ca: cert,
        lookup: (_h, o, cb) =>
          o.all
            ? cb(null, [{ address: '127.0.0.1', family: 4 }])
            : cb(null, '127.0.0.1', 4),
      },
    });
    fetch = async (input, init) =>
      (await undiciFetch(String(input), {
        ...init,
        dispatcher: agent,
        signal: init?.signal ?? AbortSignal.timeout(5000),
      } as Parameters<typeof undiciFetch>[1])) as unknown as Response;
    pool = new Pool(c.database);
    store = new TenantStore(pool);
    master = new KeycloakClient({
      baseUrl: c.keycloakAdminUrl,
      realm: 'master',
      clientId: 'j-auth-realm-creator',
      secret: async () => c.realmCreatorSecret,
      fetch,
    });
    credentials = new RealmCredentials({
      master,
      baseUrl: c.keycloakAdminUrl,
      tenants: store,
      fetch,
    });
    existingPolicy = await permissions();
    existingRoleCatalog = await catalog();
    const clients = await read<KcClient[]>(
      '/admin/realms/tenant-sample-a/clients',
    );
    mailClient = clients.find((c) => c.clientId === 'j-mail')!;
    loginClient = clients.find((c) => c.clientId === 'j-groupware')!;
    canonical = (
      await read<KcRole[]>(
        '/admin/realms/tenant-sample-a/clients/' + mailClient.id + '/roles',
      )
    ).find((r) => r.name === 'mail:read')!;
    alias = (
      await read<KcRole[]>(
        '/admin/realms/tenant-sample-a/clients/' + loginClient.id + '/roles',
      )
    ).find((r) => r.name === 'mail:read')!;
    if (!canonical || !alias || canonical.id === alias.id)
      throw new Error(
        'Legacy imported fixture with distinct aliases required. Existing realm preserved.',
      );
    const token = await fetch(
      c.keycloakPublicUrl +
        '/realms/tenant-sample-a/protocol/openid-connect/token',
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
          scope: 'openid',
        }),
      },
    );
    if (!token.ok) throw new Error('Existing fixture login failed.');
    admin = ((await token.json()) as { access_token: string }).access_token;
    app = createApp({
      pool,
      verifier: createTokenVerifier({ publicUrl: c.keycloakPublicUrl, fetch }),
      credentials,
      consoleKeyHashes: c.consoleKeyHashes,
      https: { cert, key },
    });
    await app.listen({ host: '127.0.0.1', port: 54231 });
  });
  afterAll(async () => {
    try {
      if (master) {
        for (const [username] of ownedMembers) {
          const users = await read<{ id: string; username: string }[]>(
            '/admin/realms/tenant-sample-a/users?username=' +
              username +
              '&exact=true',
          );
          for (const u of users) {
            if (u.username !== username)
              throw new Error('Fixture cleanup ownership mismatch.');
            const r = await master.request(
              '/admin/realms/tenant-sample-a/users/' + u.id,
              { method: 'DELETE' },
            );
            if (![204, 404].includes(r.status))
              throw new Error('Owned member cleanup failed.');
          }
        }
        for (const tenant of ownedTenants) {
          const r = await master.request('/admin/realms/tenant-' + tenant, {
            method: 'DELETE',
          });
          if (![204, 404].includes(r.status))
            throw new Error('Owned realm cleanup failed.');
          await pool.query('DELETE FROM tenants WHERE tenant_id=$1', [tenant]);
        }
        expect(await permissions()).toBe(existingPolicy);
        expect(await catalog()).toBe(existingRoleCatalog);
        report.samplePermissionsUnchanged = true;
        report.sampleCatalogUnchanged = true;
        await writeFile(
          '/workspace/.suite-runtime/j-auth/imported-mail-compat-evidence.json',
          JSON.stringify(report, null, 2) + '\n',
          { mode: 0o600 },
        );
      }
    } finally {
      await app?.close();
      await pool?.end();
      await agent?.close();
    }
  });
  it('selects the canonical catalog owner when the legacy DB has two same-named roles', async () => {
    const candidates = await pool.query<{ client_id: string }>(
      'SELECT client_id FROM tenant_client_roles WHERE tenant_id=$1 AND role_name=$2 ORDER BY client_id',
      ['sample-a', 'mail:read'],
    );
    expect(candidates.rows.map((r) => r.client_id)).toEqual([
      'j-groupware',
      'j-mail',
    ]);
    expect(await store.roleMapping('sample-a', 'mail:read')).toEqual({
      clientId: mailClient.id,
      roleId: canonical.id,
    });
    report.legacyDuplicateClients = candidates.rows.map((r) => r.client_id);
    report.canonicalOwner = 'j-mail';
  });
  it('actually creates a mail:read member through existing-sample HTTPS and maps only j-mail role', async () => {
    const input = candidate();
    memberUsername = input.username;
    memberPassword = input.password;
    expect(
      await read(
        '/admin/realms/tenant-sample-a/users?username=' +
          input.username +
          '&exact=true',
      ),
    ).toEqual([]);
    const result = await request('/auth/members', 'POST', input);
    expect(result.status).toBe(201);
    const body = (await result.json()) as { id: string; roles: string[] };
    memberId = body.id;
    ownedMembers.set(input.username, memberId);
    expect(body.roles).toEqual(['mail:read']);
    const roles = await read<KcRole[]>(
      '/admin/realms/tenant-sample-a/users/' +
        memberId +
        '/role-mappings/clients/' +
        mailClient.id,
    );
    expect(roles.map((r) => r.id)).toContain(canonical.id);
    const wrong = await read<KcRole[]>(
      '/admin/realms/tenant-sample-a/users/' +
        memberId +
        '/role-mappings/clients/' +
        loginClient.id,
    );
    expect(wrong.map((r) => r.id)).not.toContain(alias.id);
    report.existingSampleMemberCreate = 201;
  });
  it('keeps the wrong alias403 and supports canonical role revoke/regrant without widening FGAP', async () => {
    const wrong = await credentials
      .client('sample-a', 'member')
      .request(
        '/admin/realms/tenant-sample-a/users/' +
          memberId +
          '/role-mappings/clients/' +
          loginClient.id,
        {
          method: 'POST',
          body: JSON.stringify([{ id: alias.id, name: alias.name }]),
        },
      );
    expect(wrong.status).toBe(403);
    report.wrongAliasStillDenied = 403;
    expect(
      (
        await request(
          '/auth/members/' + memberId + '/roles/mail:read',
          'DELETE',
        )
      ).status,
    ).toBe(200);
    const regrant = await request(
      '/auth/members/' + memberId + '/roles/mail:read',
      'PUT',
    );
    expect(regrant.status).toBe(200);
    expect(((await regrant.json()) as { roles: string[] }).roles).toEqual([
      'mail:read',
    ]);
  });
  it('actually issues a valid reduced mail token for the unchanged imported sample and records scope drift', async () => {
    const config = loadServerConfig(),
      prefix =
        config.keycloakPublicUrl +
        '/realms/tenant-sample-a/protocol/openid-connect/token';
    const original = await fetch(prefix, {
      method: 'POST',
      body: new URLSearchParams({
        client_id: 'j-groupware',
        client_secret: requiredTestEnv(
          'JGW_SAMPLE_A_J_GROUPWARE_CLIENT_SECRET',
        ),
        grant_type: 'password',
        username: memberUsername,
        password: memberPassword,
        scope: 'openid',
      }),
    });
    expect(original.status).toBe(200);
    const issued = ((await original.json()) as { access_token: string })
      .access_token;
    const exchanged = await fetch(prefix, {
      method: 'POST',
      body: new URLSearchParams({
        client_id: 'j-groupware',
        client_secret: requiredTestEnv(
          'JGW_SAMPLE_A_J_GROUPWARE_CLIENT_SECRET',
        ),
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: issued,
        subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        audience: 'j-mail',
      }),
    });
    expect(exchanged.status).toBe(200);
    const reduced = ((await exchanged.json()) as { access_token: string })
      .access_token;
    const identity = await createTokenVerifier({
      publicUrl: config.keycloakPublicUrl,
      fetch,
    }).verify(reduced, { tenantId: 'sample-a', audience: 'j-mail' });
    const scopes = await read<KcRole[]>(
      '/admin/realms/tenant-sample-a/clients/' +
        loginClient.id +
        '/scope-mappings/clients/' +
        mailClient.id,
    );
    expect(scopes).toEqual([]);
    expect(identity.roles).toEqual(['mail:read']);
    expect(identity.claims.aud).toBe('j-mail');
    expect(identity.claims.sid).toBeTypeOf('string');
    expect(identity.claims.preferred_username).toBe(memberUsername);
    report.existingLoginCanonicalMailScopeEmpty = true;
    report.existingReducedTokenHasMailRole =
      identity.roles.includes('mail:read');
  });
  it('fails closed if only an alias exists and never resolves identity/admin or unknown roles', async () => {
    const tenant = 'compat-db-' + randomUUID().slice(0, 8);
    ownedTenants.add(tenant);
    await store.reserve(tenant);
    await store.activate(tenant, generateServiceKey().hash, [
      {
        clientId: 'j-groupware',
        keycloakId: randomUUID(),
        roles: [{ name: 'mail:read', keycloakId: randomUUID() }],
      },
    ]);
    for (const role of [
      'mail:read',
      'tenant:admin',
      'member:manage',
      'unknown:read',
    ])
      expect(await store.roleMapping(tenant, role)).toBeUndefined();
  });
  it('actually imports all optional clients without introducing login-client aliases and with scopes on the login consumer', async () => {
    const tenant = 'compat-import-' + randomUUID().slice(0, 8),
      selected = SERVICE_CATALOG.filter(
        (s) => s.tenantService && !s.required,
      ).map((s) => s.serviceId);
    expect(
      (await master.request('/admin/realms/tenant-' + tenant)).status,
    ).toBe(404);
    expect(
      (await pool.query('SELECT 1 FROM tenants WHERE tenant_id=$1', [tenant]))
        .rowCount,
    ).toBe(0);
    const realm = await customerTemplate(tenant, selected);
    for (const client of realm.clients) delete client.secret;
    const result = await master.request('/admin/realms', {
      method: 'POST',
      body: JSON.stringify(realm),
    });
    expect(result.status).toBe(201);
    ownedTenants.add(tenant);
    const clients = await read<KcClient[]>(
        '/admin/realms/tenant-' + tenant + '/clients',
      ),
      login = clients.find((c) => c.clientId === 'j-groupware')!,
      mail = clients.find((c) => c.clientId === 'j-mail')!;
    const loginRoles = await read<KcRole[]>(
      '/admin/realms/tenant-' + tenant + '/clients/' + login.id + '/roles',
    );
    expect(loginRoles.map((r) => r.name).sort()).toEqual(
      SERVICE_CATALOG.find((s) => s.clientId === 'j-groupware')!
        .roles.map((r) => r.name)
        .sort(),
    );
    const mailRoles = await read<KcRole[]>(
        '/admin/realms/tenant-' + tenant + '/clients/' + mail.id + '/roles',
      ),
      scopes = await read<KcRole[]>(
        '/admin/realms/tenant-' +
          tenant +
          '/clients/' +
          login.id +
          '/scope-mappings/clients/' +
          mail.id,
      );
    expect(scopes.map((r) => r.id)).toEqual(mailRoles.map((r) => r.id));
    const reverse = await read<KcRole[]>(
      '/admin/realms/tenant-' +
        tenant +
        '/clients/' +
        mail.id +
        '/scope-mappings/clients/' +
        login.id,
    );
    expect(reverse).toEqual([]);
    await configureMemberAdmin(master, tenant);
    await store.reserve(tenant);
    await store.activate(
      tenant,
      generateServiceKey().hash,
      await snapshotClients(master, tenant),
    );
    const freshPassword = randomBytes(24).toString('base64url');
    const client = credentials.client(tenant, 'member'),
      response = await client.request(
        '/admin/realms/tenant-' + tenant + '/users',
        {
          method: 'POST',
          body: JSON.stringify({
            username: 'owned-import-member',
            enabled: true,
            credentials: [
              { type: 'password', temporary: false, value: freshPassword },
            ],
          }),
        },
      );
    expect(response.status).toBe(201);
    const user = (
      await read<{ id: string }[]>(
        '/admin/realms/tenant-' +
          tenant +
          '/users?username=owned-import-member&exact=true',
      )
    )[0]!;
    const grant = await client.request(
      '/admin/realms/tenant-' +
        tenant +
        '/users/' +
        user.id +
        '/role-mappings/clients/' +
        mail.id,
      { method: 'POST', body: JSON.stringify(mailRoles) },
    );
    expect(grant.status).toBe(204);
    report.correctedImportLoginRoleNames = loginRoles.map((r) => r.name).sort();
    report.correctedImportScopedGrant = 204;
    const secret = await read<{ value: string }>(
      '/admin/realms/tenant-' +
        tenant +
        '/clients/' +
        login.id +
        '/client-secret',
    );
    const config = loadServerConfig(),
      session = await authorizationCodeLogin(
        { publicUrl: config.keycloakPublicUrl, fetch } as Parameters<
          typeof authorizationCodeLogin
        >[0],
        {
          tenantId: tenant,
          username: 'owned-import-member',
          password: freshPassword,
          clientSecret: secret.value,
        },
      );
    const exchanged = await fetch(
      config.keycloakPublicUrl +
        '/realms/tenant-' +
        tenant +
        '/protocol/openid-connect/token',
      {
        method: 'POST',
        body: new URLSearchParams({
          client_id: 'j-groupware',
          client_secret: secret.value,
          grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
          subject_token: session.access_token,
          subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          audience: 'j-mail',
        }),
      },
    );
    expect(exchanged.status).toBe(200);
    const reduced = ((await exchanged.json()) as { access_token: string })
      .access_token;
    const identity = await createTokenVerifier({
      publicUrl: config.keycloakPublicUrl,
      fetch,
    }).verify(reduced, { tenantId: tenant, audience: 'j-mail' });
    expect(identity.roles).toEqual(['mail:read']);
    report.correctedImportReducedTokenHasMailRole = true;
  });
});
