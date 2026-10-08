import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { createTokenVerifier } from '@j-auth/token-verifier';
import { createApp } from '../../apps/server/src/app.js';
import {
  KeycloakClient,
  RealmCredentials,
} from '../../apps/server/src/keycloak/client.js';
import { hashServiceKey } from '../../apps/server/src/security/service-key.js';
import { SERVICE_KEY_OVERLAP_SECONDS } from '../../apps/server/src/keycloak/provisioning.js';
import { integrationRuntime, requiredTestEnv } from './runtime.js';
import type { IntegrationRuntime } from './runtime.js';
import { authorizationCodeLogin } from './oidc-code.js';

interface CreatedCustomer {
  tenantId: string;
  username: string;
  password: string;
  clientSecret: string;
  serviceKey: string;
}
describe('isolated customer provisioning and credential rotation', () => {
  let runtime: IntegrationRuntime;
  let app: ReturnType<typeof createApp>;
  let creator: KeycloakClient;
  let creatorId: string | undefined;
  let operator: string;
  let readonlyOperator: string;
  let operatorViewerId: string | undefined;
  let failOnce: ((path: string, init?: RequestInit) => boolean) | undefined;
  const tenants = new Set<string>();
  const faultFetch: typeof fetch = async (input, init) => {
    if (failOnce?.(String(input), init)) {
      failOnce = undefined;
      return new Response('Injected dependency failure', { status: 503 });
    }
    return await runtime.fetch(input, init);
  };
  const auth = (
    token = operator,
    key = requiredTestEnv('JAUTH_CONSOLE_SERVICE_KEY'),
  ) => ({ authorization: `Bearer ${token}`, 'x-jgw-service-key': key });
  const candidate = () => {
    const tenantId = `cloud-${randomUUID().slice(0, 8)}`;
    tenants.add(tenantId);
    return {
      tenantId,
      adminUsername: 'owner',
      adminPassword: randomBytes(24).toString('base64url'),
    };
  };
  const create = async () => {
    const input = candidate();
    const result = await app.inject({
      method: 'POST',
      url: '/auth/tenants',
      headers: auth(),
      payload: input,
    });
    expect(result.statusCode).toBe(201);
    const body = result.json() as { clientSecret: string; serviceKey: string };
    expect(Object.keys(body).sort()).toEqual(['clientSecret', 'serviceKey']);
    expect(
      typeof body.clientSecret === 'string' && body.clientSecret.length >= 16,
    ).toBe(true);
    expect(
      typeof body.serviceKey === 'string' &&
        /^[A-Za-z0-9_-]{43}$/.test(body.serviceKey),
    ).toBe(true);
    expect(result.headers['cache-control']).toBe('no-store');
    return {
      tenantId: input.tenantId,
      username: input.adminUsername,
      password: input.adminPassword,
      ...body,
    } satisfies CreatedCustomer;
  };
  const currentSecret = async (customer: CreatedCustomer) => {
    const clients = await creator.request(
      `/admin/realms/tenant-${customer.tenantId}/clients?clientId=j-groupware`,
    );
    expect(clients.status).toBe(200);
    const id = ((await clients.json()) as { id: string }[])[0]!.id;
    const response = await creator.request(
      `/admin/realms/tenant-${customer.tenantId}/clients/${id}/client-secret`,
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { value: string }).value;
  };
  beforeAll(async () => {
    runtime = await integrationRuntime();
    const name = `api-creator-${randomUUID()}`;
    const secret = randomBytes(32).toString('base64url');
    const created = await runtime.admin('/admin/realms/master/clients', {
      method: 'POST',
      body: JSON.stringify({
        clientId: name,
        secret,
        enabled: true,
        publicClient: false,
        serviceAccountsEnabled: true,
        standardFlowEnabled: false,
        directAccessGrantsEnabled: false,
        fullScopeAllowed: true,
      }),
    });
    expect(created.status).toBe(201);
    creatorId = (
      await runtime.json<{ id: string }[]>(
        `/admin/realms/master/clients?clientId=${name}`,
      )
    )[0]!.id;
    const user = await runtime.json<{ id: string }>(
      `/admin/realms/master/clients/${creatorId}/service-account-user`,
    );
    const role = await runtime.json<{ id: string; name: string }>(
      '/admin/realms/master/roles/create-realm',
    );
    expect(
      (
        await runtime.admin(
          `/admin/realms/master/users/${user.id}/role-mappings/realm`,
          { method: 'POST', body: JSON.stringify([role]) },
        )
      ).status,
    ).toBe(204);
    creator = new KeycloakClient({
      baseUrl: runtime.publicUrl,
      realm: 'master',
      clientId: name,
      secret: async () => secret,
      fetch: faultFetch,
    });
    operator = (await runtime.passwordToken('operator', 'op-admin'))
      .access_token;
    const viewerName = `readonly-${randomUUID()}`;
    const viewerPassword = randomBytes(24).toString('base64url');
    const viewer = await runtime.admin('/admin/realms/operator/users', {
      method: 'POST',
      body: JSON.stringify({
        username: viewerName,
        enabled: true,
        requiredActions: [],
        credentials: [
          { type: 'password', value: viewerPassword, temporary: false },
        ],
      }),
    });
    expect(viewer.status).toBe(201);
    operatorViewerId = new URL(viewer.headers.get('location')!).pathname
      .split('/')
      .at(-1)!;
    const consoleClient = (
      await runtime.json<{ id: string }[]>(
        '/admin/realms/operator/clients?clientId=j-console',
      )
    )[0]!;
    const readRole = await runtime.json<{ id: string; name: string }>(
      `/admin/realms/operator/clients/${consoleClient.id}/roles/customer:read`,
    );
    expect(
      (
        await runtime.admin(
          `/admin/realms/operator/users/${operatorViewerId}/role-mappings/clients/${consoleClient.id}`,
          { method: 'POST', body: JSON.stringify([readRole]) },
        )
      ).status,
    ).toBe(204);
    const token = await runtime.fetch(
      `${runtime.publicUrl}/realms/operator/protocol/openid-connect/token`,
      {
        method: 'POST',
        body: new URLSearchParams({
          client_id: 'j-console',
          client_secret: requiredTestEnv(
            'JGW_OPERATOR_J_CONSOLE_CLIENT_SECRET',
          ),
          grant_type: 'password',
          username: viewerName,
          password: viewerPassword,
        }),
      },
    );
    expect(token.status).toBe(200);
    readonlyOperator = ((await token.json()) as { access_token: string })
      .access_token;
    app = createApp({
      pool: runtime.pool,
      realmCreator: creator,
      credentials: new RealmCredentials({
        master: creator,
        tenants: runtime.tenants,
        baseUrl: runtime.publicUrl,
        fetch: faultFetch,
      }),
      verifier: createTokenVerifier({
        publicUrl: runtime.publicUrl,
        fetch: runtime.fetch,
      }),
      consoleKeyHashes: [requiredTestEnv('JAUTH_CONSOLE_KEY_HASH')],
    });
  });
  afterAll(async () => {
    failOnce = undefined;
    if (app) await app.close();
    if (runtime) {
      for (const tenant of tenants) {
        await runtime.admin(`/admin/realms/tenant-${tenant}`, {
          method: 'DELETE',
        });
        await runtime.pool.query('DELETE FROM tenants WHERE tenant_id = $1', [
          tenant,
        ]);
      }
      if (operatorViewerId)
        await runtime.admin(
          `/admin/realms/operator/users/${operatorViewerId}`,
          { method: 'DELETE' },
        );
      if (creatorId)
        await runtime.admin(`/admin/realms/master/clients/${creatorId}`, {
          method: 'DELETE',
        });
      await runtime.close();
    }
  });

  it('rejects unauthenticated, mixed-key and read-only calls before provisioning', async () => {
    const input = candidate();
    for (const [headers, status] of [
      [{}, 401],
      [auth(operator, requiredTestEnv('JGW_SAMPLE_A_SERVICE_KEY')), 401],
      [auth(readonlyOperator), 403],
    ] as const) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/auth/tenants',
            headers,
            payload: input,
          })
        ).statusCode,
      ).toBe(status);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/auth/tenants/${input.tenantId}/rotate-secrets`,
            headers,
          })
        ).statusCode,
      ).toBe(status);
    }
    expect(
      (
        await runtime.pool.query('SELECT 1 FROM tenants WHERE tenant_id = $1', [
          input.tenantId,
        ])
      ).rowCount,
    ).toBe(0);
  });

  it('validates tenant and administrator input and hides inactive targets', async () => {
    for (const changes of [
      { tenantId: 'operator' },
      { tenantId: '../escape' },
      { adminUsername: 'service-account-forbidden' },
      { adminUsername: ' Service-Account-Forbidden ' },
      { adminPassword: '' },
      { unknown: true },
    ]) {
      const input = { ...candidate(), ...changes };
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/auth/tenants',
            headers: auth(),
            payload: input,
          })
        ).statusCode,
      ).toBe(400);
    }
    const missing = candidate();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/auth/tenants/${missing.tenantId}/rotate-secrets`,
          headers: auth(),
        })
      ).statusCode,
    ).toBe(404);
    await runtime.tenants.reserve(missing.tenantId);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/auth/tenants/${missing.tenantId}/rotate-secrets`,
          headers: auth(),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await runtime.pool.query(
          'SELECT status FROM tenants WHERE tenant_id = $1',
          [missing.tenantId],
        )
      ).rows[0].status,
    ).toBe('creating');
  });

  it('creates with create-realm alone, stores only hashes/UUIDs and never replays secrets', async () => {
    const customer = await create();
    const row = (
      await runtime.pool.query('SELECT * FROM tenants WHERE tenant_id = $1', [
        customer.tenantId,
      ])
    ).rows[0];
    expect(row.status).toBe('active');
    expect(row.service_key_hash === hashServiceKey(customer.serviceKey)).toBe(
      true,
    );
    for (const value of [
      customer.password,
      customer.clientSecret,
      customer.serviceKey,
    ])
      expect(JSON.stringify(row).includes(value)).toBe(false);
    const realm = await runtime.json<{ attributes: Record<string, string> }>(
      `/admin/realms/tenant-${customer.tenantId}`,
    );
    expect(realm.attributes['j-auth-provisioning-id']).toBe(
      row.provisioning_id,
    );
    expect(
      await runtime.tenants.roleMapping(customer.tenantId, 'board:write'),
    ).toBeTruthy();
    const repeated = await app.inject({
      method: 'POST',
      url: '/auth/tenants',
      headers: auth(),
      payload: {
        tenantId: customer.tenantId,
        adminUsername: customer.username,
        adminPassword: customer.password,
      },
    });
    expect(repeated.statusCode).toBe(409);
    expect(
      repeated.body.includes(customer.clientSecret) ||
        repeated.body.includes(customer.serviceKey),
    ).toBe(false);
    expect((await currentSecret(customer)) === customer.clientSecret).toBe(
      true,
    );
    expect(
      (await creator.request('/admin/realms/tenant-sample-a/clients')).status,
    ).toBe(403);
  });

  it('performs real authorization code with PKCE and keeps password grant disabled', async () => {
    const customer = await create();
    const token = await authorizationCodeLogin(runtime, customer);
    const verified = await createTokenVerifier({
      publicUrl: runtime.publicUrl,
      fetch: runtime.fetch,
    }).verify(token.access_token, {
      tenantId: customer.tenantId,
      audience: 'j-groupware',
    });
    expect(verified.roles).toContain('tenant:admin');
    expect(verified.roles).toContain('member:manage');
    expect(verified.roles).not.toContain('mail:read');
    const members = await app.inject({
      method: 'GET',
      url: '/auth/members',
      headers: {
        authorization: `Bearer ${token.access_token}`,
        'x-jgw-service-key': customer.serviceKey,
      },
    });
    expect(members.statusCode).toBe(200);
    expect(
      members.json().items.map((u: { username: string }) => u.username),
    ).toEqual(['owner']);
    const prefix = `${runtime.publicUrl}/realms/tenant-${customer.tenantId}/protocol/openid-connect`;
    const password = await runtime.fetch(`${prefix}/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'j-groupware',
        client_secret: customer.clientSecret,
        username: customer.username,
        password: customer.password,
      }),
    });
    expect(password.status).toBe(400);
    const authUrl = new URL(`${prefix}/auth`);
    authUrl.search = new URLSearchParams({
      client_id: 'j-groupware',
      response_type: 'code',
      redirect_uri: `https://gw.${customer.tenantId}.jgw.test/auth/callback`,
    }).toString();
    const missingPkce = await runtime.fetch(authUrl, { redirect: 'manual' });
    expect(missingPkce.status).toBe(302);
    const rejected = new URL(missingPkce.headers.get('location')!);
    expect(rejected.searchParams.get('error')).toBe('invalid_request');
    expect(rejected.searchParams.has('code')).toBe(false);
    expect(rejected.origin).toBe(`https://gw.${customer.tenantId}.jgw.test`);
    authUrl.searchParams.set(
      'redirect_uri',
      'https://evil.jgw.test/auth/callback',
    );
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set(
      'code_challenge',
      randomBytes(32).toString('base64url'),
    );
    expect((await runtime.fetch(authUrl, { redirect: 'manual' })).status).toBe(
      400,
    );
  });

  it('runs subscription changes in a freshly provisioned tenant using only its provisioner', async () => {
    const customer = await create();
    const url = `/auth/tenants/${customer.tenantId}/services/j-talk`;
    expect(
      (await app.inject({ method: 'PUT', url, headers: auth() })).statusCode,
    ).toBe(200);
    const enabled = await authorizationCodeLogin(runtime, customer);
    const identity = await createTokenVerifier({
      publicUrl: runtime.publicUrl,
      fetch: runtime.fetch,
    }).verify(enabled.access_token, {
      tenantId: customer.tenantId,
      audience: 'j-talk',
    });
    expect(identity.roles).toContain('talk:write');
    expect(identity.roles).toContain('talk:read');
    expect(
      (await app.inject({ method: 'DELETE', url, headers: auth() })).statusCode,
    ).toBe(200);
    const removed = await authorizationCodeLogin(runtime, customer);
    await expect(
      createTokenVerifier({
        publicUrl: runtime.publicUrl,
        fetch: runtime.fetch,
      }).verify(removed.access_token, {
        tenantId: customer.tenantId,
        audience: 'j-talk',
      }),
    ).rejects.toMatchObject({ kind: 'invalid' });
    expect(
      await runtime.tenants.roleMapping(customer.tenantId, 'talk:write'),
    ).toBeUndefined();
  });

  it('resumes a partial realm safely with the same administrator and no password reset', async () => {
    const input = candidate();
    input.adminUsername = 'Owner';
    failOnce = (path, init) =>
      path.includes('/authz/resource-server/permission/scope') &&
      init?.method === 'POST';
    const failed = await app.inject({
      method: 'POST',
      url: '/auth/tenants',
      headers: auth(),
      payload: input,
    });
    expect(failed.statusCode).toBe(503);
    const row = (
      await runtime.pool.query(
        'SELECT status, service_key_hash FROM tenants WHERE tenant_id = $1',
        [input.tenantId],
      )
    ).rows[0];
    expect(row).toEqual({ status: 'failed', service_key_hash: null });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/auth/tenants',
          headers: auth(),
          payload: { ...input, adminUsername: 'other-owner' },
        })
      ).statusCode,
    ).toBe(409);
    const resumed = await app.inject({
      method: 'POST',
      url: '/auth/tenants',
      headers: auth(),
      payload: {
        ...input,
        adminPassword: randomBytes(24).toString('base64url'),
      },
    });
    expect(resumed.statusCode).toBe(201);
    const customer = {
      tenantId: input.tenantId,
      username: input.adminUsername,
      password: input.adminPassword,
      ...resumed.json<{ clientSecret: string; serviceKey: string }>(),
    } as CreatedCustomer;
    expect(
      (await authorizationCodeLogin(runtime, customer)).access_token.length > 0,
    ).toBe(true);
    const users = await runtime.json<{ username: string }[]>(
      `/admin/realms/tenant-${input.tenantId}/users?username=owner&exact=true`,
    );
    expect(users).toHaveLength(1);
  });

  it('never adopts an unrelated existing realm or touches another tenant', async () => {
    const input = candidate();
    expect(
      (
        await runtime.admin('/admin/realms', {
          method: 'POST',
          body: JSON.stringify({
            realm: `tenant-${input.tenantId}`,
            enabled: true,
            attributes: { untouched: 'foreign' },
          }),
        })
      ).status,
    ).toBe(201);
    const before = await runtime.tenants.serviceIds('sample-a');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/auth/tenants',
          headers: auth(),
          payload: input,
        })
      ).statusCode,
    ).toBe(409);
    const realm = await runtime.json<{ attributes: Record<string, string> }>(
      `/admin/realms/tenant-${input.tenantId}`,
    );
    expect(realm.attributes.untouched).toBe('foreign');
    expect(realm.attributes['j-auth-provisioning-id']).toBeUndefined();
    expect(await runtime.tenants.serviceIds('sample-a')).toEqual(before);
    expect(
      (
        await runtime.pool.query(
          'SELECT status, service_key_hash FROM tenants WHERE tenant_id = $1',
          [input.tenantId],
        )
      ).rows[0],
    ).toEqual({ status: 'failed', service_key_hash: null });
  });

  it('rejects an owned realm whose creation marker does not match the reserved tenant', async () => {
    const input = candidate();
    expect(
      (
        await creator.request('/admin/realms', {
          method: 'POST',
          body: JSON.stringify({
            realm: `tenant-${input.tenantId}`,
            enabled: true,
            attributes: { 'j-auth-provisioning-id': randomUUID() },
          }),
        })
      ).status,
    ).toBe(201);
    creator.clear();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/auth/tenants',
          headers: auth(),
          payload: input,
        })
      ).statusCode,
    ).toBe(409);
    const users = await runtime.json<{ username: string }[]>(
      `/admin/realms/tenant-${input.tenantId}/users`,
    );
    expect(users).toHaveLength(0);
  });

  it('leaves failed state on unavailable creation and resumes when the dependency recovers', async () => {
    const input = candidate();
    failOnce = (path, init) =>
      path.endsWith('/admin/realms') && init?.method === 'POST';
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/auth/tenants',
          headers: auth(),
          payload: input,
        })
      ).statusCode,
    ).toBe(503);
    expect(
      (
        await runtime.pool.query(
          'SELECT status FROM tenants WHERE tenant_id = $1',
          [input.tenantId],
        )
      ).rows[0].status,
    ).toBe('failed');
    expect(
      (await runtime.admin(`/admin/realms/tenant-${input.tenantId}`)).status,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/auth/tenants',
          headers: auth(),
          payload: input,
        })
      ).statusCode,
    ).toBe(201);
  });

  it('rolls back activation on a real database error and recovers the existing realm', async () => {
    const input = candidate();
    const name = `test_activate_${randomUUID().replaceAll('-', '')}`;
    await runtime.pool.query(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id = '${input.tenantId}' AND NEW.status = 'active' THEN RAISE EXCEPTION 'Injected activation failure'; END IF; RETURN NEW; END $$`,
    );
    await runtime.pool.query(
      `CREATE TRIGGER ${name} BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION ${name}()`,
    );
    try {
      const failed = await app.inject({
        method: 'POST',
        url: '/auth/tenants',
        headers: auth(),
        payload: input,
      });
      expect(failed.statusCode).toBe(503);
      expect(failed.body).not.toContain('Injected');
      expect(
        (
          await runtime.pool.query(
            'SELECT status, service_key_hash FROM tenants WHERE tenant_id = $1',
            [input.tenantId],
          )
        ).rows[0],
      ).toEqual({ status: 'failed', service_key_hash: null });
      expect(await runtime.tenants.serviceIds(input.tenantId)).toEqual([]);
    } finally {
      await runtime.pool.query(`DROP TRIGGER ${name} ON tenants`);
      await runtime.pool.query(`DROP FUNCTION ${name}()`);
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/auth/tenants',
          headers: auth(),
          payload: input,
        })
      ).statusCode,
    ).toBe(201);
  });

  it('serializes duplicate creates and returns secrets from only one completion', async () => {
    const input = candidate();
    const results = await Promise.all(
      [0, 1].map(() =>
        app.inject({
          method: 'POST',
          url: '/auth/tenants',
          headers: auth(),
          payload: input,
        }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    const users = await runtime.json<{ username: string }[]>(
      `/admin/realms/tenant-${input.tenantId}/users?username=owner&exact=true`,
    );
    expect(users).toHaveLength(1);
  });

  it('rotates only the isolated customer with a fixed service-key overlap and immediate client-secret replacement', async () => {
    const customer = await create();
    const other = await create();
    const session = await authorizationCodeLogin(runtime, customer);
    const rotate = await app.inject({
      method: 'POST',
      url: `/auth/tenants/${customer.tenantId}/rotate-secrets`,
      headers: auth(),
    });
    expect(rotate.statusCode).toBe(200);
    const changed = rotate.json() as {
      clientSecret: string;
      serviceKey: string;
    };
    expect(
      changed.clientSecret !== customer.clientSecret &&
        changed.serviceKey !== customer.serviceKey,
    ).toBe(true);
    expect((await currentSecret(other)) === other.clientSecret).toBe(true);
    const row = (
      await runtime.pool.query('SELECT * FROM tenants WHERE tenant_id = $1', [
        customer.tenantId,
      ])
    ).rows[0];
    expect(
      row.previous_service_key_hash === hashServiceKey(customer.serviceKey),
    ).toBe(true);
    expect(row.service_key_hash === hashServiceKey(changed.serviceKey)).toBe(
      true,
    );
    expect(
      Math.abs(
        (row.previous_key_expires_at.getTime() - Date.now()) / 1000 -
          SERVICE_KEY_OVERLAP_SECONDS,
      ),
    ).toBeLessThan(10);
    const member = async (key: string) =>
      await app.inject({
        method: 'GET',
        url: '/auth/members',
        headers: {
          authorization: `Bearer ${session.access_token}`,
          'x-jgw-service-key': key,
        },
      });
    expect((await member(customer.serviceKey)).statusCode).toBe(200);
    expect((await member(changed.serviceKey)).statusCode).toBe(200);
    expect((await member(other.serviceKey)).statusCode).toBe(401);
    const tokenUrl = `${runtime.publicUrl}/realms/tenant-${customer.tenantId}/protocol/openid-connect/token`;
    const oldSecret = await runtime.fetch(tokenUrl, {
      method: 'POST',
      body: new URLSearchParams({
        client_id: 'j-groupware',
        client_secret: customer.clientSecret,
        grant_type: 'authorization_code',
        code: 'invalid-code',
        redirect_uri: `https://gw.${customer.tenantId}.jgw.test/auth/callback`,
      }),
    });
    expect(oldSecret.status).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/auth/tenants/${customer.tenantId}/rotate-secrets`,
          headers: auth(readonlyOperator),
        })
      ).statusCode,
    ).toBe(403);
    const repeated = await app.inject({
      method: 'POST',
      url: `/auth/tenants/${customer.tenantId}/rotate-secrets`,
      headers: auth(),
    });
    expect(repeated.statusCode).toBe(409);
    expect((await currentSecret(customer)) === changed.clientSecret).toBe(true);
    await runtime.pool.query(
      "UPDATE tenants SET previous_key_expires_at = now() - interval '1 second' WHERE tenant_id = $1",
      [customer.tenantId],
    );
    expect((await member(customer.serviceKey)).statusCode).toBe(401);
    expect((await member(changed.serviceKey)).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/auth/tenants/${customer.tenantId}/rotate-secrets`,
          headers: auth(),
        })
      ).statusCode,
    ).toBe(200);
  });

  it('fails closed on an unavailable rotation endpoint and recovers without changing the original key', async () => {
    const customer = await create();
    failOnce = (path, init) =>
      path.endsWith('/client-secret') && init?.method === 'POST';
    const failed = await app.inject({
      method: 'POST',
      url: `/auth/tenants/${customer.tenantId}/rotate-secrets`,
      headers: auth(),
    });
    expect(failed.statusCode).toBe(503);
    expect(failed.json().message).toContain('could not be confirmed');
    expect(failed.body).not.toContain('Injected');
    expect((await currentSecret(customer)) === customer.clientSecret).toBe(
      true,
    );
    const row = (
      await runtime.pool.query(
        'SELECT service_key_hash FROM tenants WHERE tenant_id = $1',
        [customer.tenantId],
      )
    ).rows[0];
    expect(row.service_key_hash === hashServiceKey(customer.serviceKey)).toBe(
      true,
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/auth/tenants/${customer.tenantId}/rotate-secrets`,
          headers: auth(),
        })
      ).statusCode,
    ).toBe(200);
  });

  it('reports client-secret partial success when the service-key database update fails and permits recovery', async () => {
    const customer = await create();
    const name = `test_rotate_${randomUUID().replaceAll('-', '')}`;
    await runtime.pool.query(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id = '${customer.tenantId}' AND OLD.status = 'active' AND NEW.service_key_hash IS DISTINCT FROM OLD.service_key_hash THEN RAISE EXCEPTION 'Injected key write failure'; END IF; RETURN NEW; END $$`,
    );
    await runtime.pool.query(
      `CREATE TRIGGER ${name} BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION ${name}()`,
    );
    try {
      const result = await app.inject({
        method: 'POST',
        url: `/auth/tenants/${customer.tenantId}/rotate-secrets`,
        headers: auth(),
      });
      expect(result.statusCode).toBe(503);
      expect(result.json().message).toContain('Client secret changed');
      expect((await currentSecret(customer)) !== customer.clientSecret).toBe(
        true,
      );
      const row = (
        await runtime.pool.query(
          'SELECT service_key_hash, previous_service_key_hash FROM tenants WHERE tenant_id = $1',
          [customer.tenantId],
        )
      ).rows[0];
      expect(row.service_key_hash === hashServiceKey(customer.serviceKey)).toBe(
        true,
      );
      expect(row.previous_service_key_hash).toBeNull();
    } finally {
      await runtime.pool.query(`DROP TRIGGER ${name} ON tenants`);
      await runtime.pool.query(`DROP FUNCTION ${name}()`);
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/auth/tenants/${customer.tenantId}/rotate-secrets`,
          headers: auth(),
        })
      ).statusCode,
    ).toBe(200);
  });
});
