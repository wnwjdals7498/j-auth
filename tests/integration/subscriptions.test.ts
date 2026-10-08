import { beforeAll, afterAll, afterEach, describe, expect, it } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { decodeJwt } from 'jose';
import { createTokenVerifier } from '@j-auth/token-verifier';
import { createApp } from '../../apps/server/src/app.js';
import { RealmCredentials } from '../../apps/server/src/keycloak/client.js';
import type { KeycloakClient } from '../../apps/server/src/keycloak/client.js';
import {
  configureProvisioner,
  readKeycloak,
} from '../../apps/server/src/keycloak/realm-model.js';
import { configureMemberAdmin } from '../../apps/server/src/keycloak/admin-permissions.js';
import { SubscriptionService } from '../../apps/server/src/keycloak/subscriptions.js';
import { integrationRuntime, requiredTestEnv } from './runtime.js';
import type { IntegrationRuntime } from './runtime.js';

describe('isolated real Keycloak subscription management', () => {
  let runtime: IntegrationRuntime;
  let app: ReturnType<typeof createApp>;
  let credentials: RealmCredentials;
  let provisioner: KeycloakClient;
  let operator: string;
  let customer: string;
  let failOnce: ((path: string, init?: RequestInit) => boolean) | undefined;
  const prefix = '/admin/realms/tenant-sample-c';
  const key = () => requiredTestEnv('JAUTH_CONSOLE_SERVICE_KEY');
  let memberId: string | undefined;
  const createdUsers: { realm: string; id: string }[] = [];
  const faultFetch: typeof fetch = async (input, init) => {
    if (failOnce?.(String(input), init)) {
      failOnce = undefined;
      return new Response('Injected dependency failure', { status: 503 });
    }
    return await runtime.fetch(input, init);
  };
  const api = async (
    method: 'GET' | 'PUT' | 'DELETE',
    suffix = '',
    token: string | undefined = operator,
    serviceKey: string | undefined = key(),
  ) =>
    await app.inject({
      method,
      url: `/auth/tenants/sample-c/services${suffix}`,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(serviceKey ? { 'x-jgw-service-key': serviceKey } : {}),
      },
    });
  const tokenFor = async (username: string, password: string) => {
    const result = await runtime.fetch(
      `${runtime.publicUrl}/realms/tenant-sample-c/protocol/openid-connect/token`,
      {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'password',
          client_id: 'j-groupware',
          client_secret: requiredTestEnv(
            'JGW_SAMPLE_C_J_GROUPWARE_CLIENT_SECRET',
          ),
          username,
          password,
          scope: 'openid',
        }),
      },
    );
    expect(result.status).toBe(200);
    return decodeJwt(
      ((await result.json()) as { access_token: string }).access_token,
    );
  };
  beforeAll(async () => {
    runtime = await integrationRuntime();
    await configureProvisioner(runtime.master, 'sample-c');
    await configureMemberAdmin(runtime.master, 'sample-c');
    credentials = new RealmCredentials({
      master: runtime.master,
      tenants: runtime.tenants,
      baseUrl: runtime.publicUrl,
      fetch: faultFetch,
    });
    provisioner = credentials.client('sample-c', 'provisioner');
    operator = (await runtime.passwordToken('operator', 'op-admin'))
      .access_token;
    customer = (await runtime.passwordToken('sample-c', 'c-admin'))
      .access_token;
    app = createApp({
      pool: runtime.pool,
      credentials,
      verifier: createTokenVerifier({
        publicUrl: runtime.publicUrl,
        fetch: runtime.fetch,
      }),
      consoleKeyHashes: [requiredTestEnv('JAUTH_CONSOLE_KEY_HASH')],
    });
  });
  afterEach(async () => {
    failOnce = undefined;
    if (memberId) {
      await runtime.admin(`${prefix}/users/${memberId}`, { method: 'DELETE' });
      memberId = undefined;
    }
    await new SubscriptionService(runtime.tenants, credentials).change(
      'sample-c',
      'j-talk',
      false,
    );
  });
  afterAll(async () => {
    if (app) await app.close();
    if (runtime) {
      for (const user of createdUsers)
        await runtime.admin(`/admin/realms/${user.realm}/users/${user.id}`, {
          method: 'DELETE',
        });
      await runtime.close();
    }
  });

  it('reads actual realm clients and requires both operator token and console key', async () => {
    expect((await api('GET')).json()).toEqual({
      tenantId: 'sample-c',
      services: ['j-groupware'],
    });
    expect((await api('GET', '', '')).statusCode).toBe(401);
    expect((await api('GET', '', operator, '')).statusCode).toBe(401);
    expect(
      (
        await api(
          'PUT',
          '/j-talk',
          customer,
          requiredTestEnv('JGW_SAMPLE_C_SERVICE_KEY'),
        )
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await api(
          'PUT',
          '/j-talk',
          operator,
          requiredTestEnv('JGW_SAMPLE_C_SERVICE_KEY'),
        )
      ).statusCode,
    ).toBe(401);
    expect((await api('GET')).json().services).toEqual(['j-groupware']);
  });

  it('rejects an actual read-only operator before changing customer state', async () => {
    const username = `viewer-${randomUUID()}`;
    const password = randomBytes(24).toString('base64url');
    const created = await runtime.admin('/admin/realms/operator/users', {
      method: 'POST',
      body: JSON.stringify({
        username,
        enabled: true,
        requiredActions: [],
        credentials: [{ type: 'password', value: password, temporary: false }],
      }),
    });
    expect(created.status).toBe(201);
    const id = new URL(created.headers.get('location')!).pathname
      .split('/')
      .at(-1)!;
    createdUsers.push({ realm: 'operator', id });
    const consoleClient = (
      await runtime.json<{ id: string }[]>(
        '/admin/realms/operator/clients?clientId=j-console',
      )
    )[0]!;
    const role = await runtime.json<{ id: string; name: string }>(
      `/admin/realms/operator/clients/${consoleClient.id}/roles/customer:read`,
    );
    expect(
      (
        await runtime.admin(
          `/admin/realms/operator/users/${id}/role-mappings/clients/${consoleClient.id}`,
          { method: 'POST', body: JSON.stringify([role]) },
        )
      ).status,
    ).toBe(204);
    const result = await runtime.fetch(
      `${runtime.publicUrl}/realms/operator/protocol/openid-connect/token`,
      {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'password',
          client_id: 'j-console',
          client_secret: requiredTestEnv(
            'JGW_OPERATOR_J_CONSOLE_CLIENT_SECRET',
          ),
          username,
          password,
        }),
      },
    );
    expect(result.status).toBe(200);
    const viewer = ((await result.json()) as { access_token: string })
      .access_token;
    expect((await api('GET', '', viewer)).statusCode).toBe(403);
    expect((await api('PUT', '/j-talk', viewer)).statusCode).toBe(403);
    expect((await api('DELETE', '/j-talk', viewer)).statusCode).toBe(403);
    expect((await api('GET')).json().services).toEqual(['j-groupware']);
  });

  it('activates idempotently and updates composite roles, scopes, mapper and FGAP', async () => {
    expect((await api('PUT', '/j-talk')).statusCode).toBe(200);
    expect((await api('PUT', '/j-talk')).statusCode).toBe(200);
    const clients = await runtime.json<
      {
        id: string;
        clientId: string;
        standardFlowEnabled: boolean;
        directAccessGrantsEnabled: boolean;
        serviceAccountsEnabled: boolean;
      }[]
    >(`${prefix}/clients`);
    expect(clients.filter((c) => c.clientId === 'j-talk')).toHaveLength(1);
    const talk = clients.find((c) => c.clientId === 'j-talk')!;
    expect([
      talk.standardFlowEnabled,
      talk.directAccessGrantsEnabled,
      talk.serviceAccountsEnabled,
    ]).toEqual([false, false, false]);
    const composite = await runtime.json<{ name: string }[]>(
      `${prefix}/clients/${talk.id}/roles/talk:write/composites`,
    );
    expect(composite.map((r) => r.name)).toContain('talk:read');
    const login = clients.find((c) => c.clientId === 'j-groupware')!;
    const scopes = await runtime.json<{ name: string }[]>(
      `${prefix}/clients/${login.id}/scope-mappings/clients/${talk.id}`,
    );
    expect(scopes.map((r) => r.name).sort()).toEqual([
      'talk:read',
      'talk:write',
    ]);
    const mappers = await runtime.json<{ name: string }[]>(
      `${prefix}/clients/${login.id}/protocol-mappers/models`,
    );
    for (const name of ['audience-j-talk', 'client-roles-j-talk'])
      expect(mappers.filter((m) => m.name === name)).toHaveLength(1);
    const claims = decodeJwt(
      (await runtime.passwordToken('sample-c', 'c-admin')).access_token,
    );
    expect(claims.aud).toContain('j-talk');
    expect(
      (claims.resource_access as Record<string, { roles: string[] }>)[
        'j-talk'
      ]!.roles.sort(),
    ).toEqual(['talk:read', 'talk:write']);
    const username = `subscription-${randomUUID()}`;
    const password = randomBytes(24).toString('base64url');
    const member = await app.inject({
      method: 'POST',
      url: '/auth/members',
      headers: {
        authorization: `Bearer ${customer}`,
        'x-jgw-service-key': requiredTestEnv('JGW_SAMPLE_C_SERVICE_KEY'),
      },
      payload: { username, password, roles: ['talk:write'] },
    });
    expect(member.statusCode).toBe(201);
    memberId = member.json().id as string;
    expect(member.json().roles.sort()).toEqual(['talk:read', 'talk:write']);
    expect((await tokenFor(username, password)).aud).toContain('j-talk');
    expect((await api('DELETE', '/j-talk')).statusCode).toBe(200);
    expect((await api('DELETE', '/j-talk')).statusCode).toBe(200);
    const after = await tokenFor(username, password);
    expect(after.aud).not.toContain('j-talk');
    expect(
      (after.resource_access as Record<string, unknown>)?.['j-talk'],
    ).toBeUndefined();
    expect(
      await runtime.tenants.roleMapping('sample-c', 'talk:write'),
    ).toBeUndefined();
  });

  it('gets services from Keycloak even when the persisted client snapshot is stale', async () => {
    expect((await api('PUT', '/j-talk')).statusCode).toBe(200);
    await runtime.pool.query(
      "DELETE FROM tenant_clients WHERE tenant_id = 'sample-c' AND client_id = 'j-talk'",
    );
    expect((await api('GET')).json().services).toContain('j-talk');
    expect((await api('PUT', '/j-talk')).statusCode).toBe(200);
    expect(await runtime.tenants.clientId('sample-c', 'j-talk')).toBeTruthy();
  });

  it('rejects required/unknown services and inactive/malformed tenants without mutation', async () => {
    for (const id of ['j-groupware', 'j-console', 'unknown'])
      expect((await api('DELETE', `/${id}`)).statusCode).toBe(400);
    for (const [tenant, status] of [
      ['unknown-tenant', 404],
      ['operator', 400],
    ] as const) {
      const result = await app.inject({
        method: 'PUT',
        url: `/auth/tenants/${tenant}/services/j-talk`,
        headers: {
          authorization: `Bearer ${operator}`,
          'x-jgw-service-key': key(),
        },
      });
      expect(result.statusCode).toBe(status);
    }
    expect((await api('GET')).json().services).toEqual(['j-groupware']);
  });

  it('keeps another tenant unchanged and the provisioner realm-scoped', async () => {
    const before = await runtime.tenants.serviceIds('sample-a');
    expect((await api('PUT', '/j-talk')).statusCode).toBe(200);
    expect(await runtime.tenants.serviceIds('sample-a')).toEqual(before);
    expect(
      (await provisioner.request('/admin/realms/tenant-sample-a/clients'))
        .status,
    ).toBe(403);
    expect(
      (
        await provisioner.request(`${prefix}/users`, {
          method: 'POST',
          body: JSON.stringify({ username: `forbidden-${randomUUID()}` }),
        })
      ).status,
    ).toBe(403);
  });

  it('resumes activation after an injected dependency failure without duplicate grants', async () => {
    failOnce = (path, init) =>
      path.includes('/scope-mappings/clients/') && init?.method === 'POST';
    const failed = await api('PUT', '/j-talk');
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain('Injected');
    expect(
      await runtime.tenants.clientId('sample-c', 'j-talk'),
    ).toBeUndefined();
    expect((await api('GET')).json().services).toContain('j-talk');
    expect((await api('PUT', '/j-talk')).statusCode).toBe(200);
    expect((await api('PUT', '/j-talk')).statusCode).toBe(200);
    expect(
      await runtime.tenants.roleMapping('sample-c', 'talk:write'),
    ).toBeTruthy();
  });

  it('resumes removal after a failed client delete and leaves no stale FGAP grants', async () => {
    expect((await api('PUT', '/j-talk')).statusCode).toBe(200);
    const id = await runtime.tenants.clientId('sample-c', 'j-talk');
    failOnce = (path, init) =>
      path.endsWith(`/clients/${id}`) && init?.method === 'DELETE';
    expect((await api('DELETE', '/j-talk')).statusCode).toBe(503);
    expect((await api('DELETE', '/j-talk')).statusCode).toBe(200);
    const permissions = (
      await runtime.json<{ id: string }[]>(
        `${prefix}/clients?clientId=admin-permissions`,
      )
    )[0]!;
    const grants = await runtime.json<{ name: string }[]>(
      `${prefix}/clients/${permissions.id}/authz/resource-server/permission/scope`,
    );
    expect(grants.some((p) => p.name.includes('talk'))).toBe(false);
    expect((await api('GET')).json().services).toEqual(['j-groupware']);
  });

  it('rejects concurrent mutations with a real PostgreSQL advisory lock', async () => {
    let release!: () => void;
    let started!: () => void;
    const acquired = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held = runtime.tenants.withLock('sample-c', async () => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await acquired;
    try {
      expect((await api('PUT', '/j-talk')).statusCode).toBe(409);
    } finally {
      release();
      await held;
    }
    expect((await api('PUT', '/j-talk')).statusCode).toBe(200);
  });

  it('uses manage-clients plus manage-realm and fails closed when either is missing', async () => {
    const clients = await readKeycloak<{ id: string; clientId: string }[]>(
      runtime.master,
      `${prefix}/clients`,
    );
    const management = clients.find((c) => c.clientId === 'realm-management')!;
    const provisionerId = clients.find(
      (c) => c.clientId === 'j-auth-provisioner',
    )!.id;
    const user = await runtime.json<{ id: string }>(
      `${prefix}/clients/${provisionerId}/service-account-user`,
    );
    const assigned = await runtime.json<{ name: string }[]>(
      `${prefix}/users/${user.id}/role-mappings/clients/${management.id}`,
    );
    expect(assigned.map((r) => r.name).sort()).toEqual([
      'manage-clients',
      'manage-realm',
    ]);
    for (const [name, path, method, body] of [
      [
        'manage-clients',
        `${prefix}/clients`,
        'POST',
        { clientId: `denied-${randomUUID()}` },
      ],
      ['manage-realm', `${prefix}/roles/tenant:admin/composites`, 'POST', []],
    ] as const) {
      const role = await runtime.json<{ id: string; name: string }>(
        `${prefix}/clients/${management.id}/roles/${name}`,
      );
      try {
        expect(
          (
            await runtime.admin(
              `${prefix}/users/${user.id}/role-mappings/clients/${management.id}`,
              { method: 'DELETE', body: JSON.stringify([role]) },
            )
          ).status,
        ).toBe(204);
        provisioner.clear();
        expect(
          (
            await provisioner.request(path, {
              method,
              body: JSON.stringify(body),
            })
          ).status,
        ).toBe(403);
      } finally {
        expect(
          (
            await runtime.admin(
              `${prefix}/users/${user.id}/role-mappings/clients/${management.id}`,
              { method: 'POST', body: JSON.stringify([role]) },
            )
          ).status,
        ).toBe(204);
        provisioner.clear();
      }
    }
  });
});
