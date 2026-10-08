import { readFile } from 'node:fs/promises';
import { Agent, fetch as undiciFetch } from 'undici';
import { Pool } from 'pg';
import {
  CLIENT_IDS,
  SERVICE_CATALOG,
  customerRealmName,
} from '@j-auth/contracts';
import { loadDatabaseConfig } from '../../apps/server/src/config.js';
import { migrate } from '../../apps/server/src/db/migrate.js';
import { TenantStore } from '../../apps/server/src/db/tenants.js';
import { hashServiceKey } from '../../apps/server/src/security/service-key.js';
import { KeycloakClient } from '../../apps/server/src/keycloak/client.js';

export function requiredTestEnv(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(
      `Integration tests require ${name} in an isolated external test env. Tests are not skipped.`,
    );
  return value;
}

export async function databaseRuntime() {
  if (requiredTestEnv('JAUTH_TEST_RUNTIME') !== 'isolated-cloud')
    throw new Error('Use the isolated cloud test runtime.');
  const pool = new Pool(loadDatabaseConfig());
  try {
    await migrate(pool);
  } catch (error) {
    await pool.end();
    throw error;
  }
  return {
    pool,
    tenants: new TenantStore(pool),
    close: async () => {
      await pool.end();
    },
  };
}

export async function integrationRuntime() {
  if (requiredTestEnv('JAUTH_TEST_RUNTIME') !== 'isolated-cloud')
    throw new Error('Use the isolated cloud test runtime.');
  const publicUrl = requiredTestEnv('KC_PUBLIC_URL');
  if (new URL(publicUrl).hostname !== 'auth.jgw.test')
    throw new Error('Cloud test issuer must be auth.jgw.test.');
  const dispatcher = new Agent({
    connect: {
      ca: await readFile(requiredTestEnv('JAUTH_TLS_CERTIFICATE'), 'utf8'),
      lookup: (_host, options, callback) => {
        if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
        else callback(null, '127.0.0.1', 4);
      },
    },
  });
  const fetch: typeof globalThis.fetch = async (input, init) =>
    (await undiciFetch(String(input), { ...init, dispatcher } as Parameters<
      typeof undiciFetch
    >[1])) as unknown as Response;
  const { pool, tenants } = await databaseRuntime();
  // Compose start is asynchronous; readiness must succeed before fixture writes.
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      ready = (
        await fetch(
          `${publicUrl}/realms/tenant-sample-b/.well-known/openid-configuration`,
          {
            signal: AbortSignal.timeout(1000),
          },
        )
      ).ok;
    } catch {
      /* Retry only the bounded startup readiness probe. */
    }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) {
    await pool.end();
    await dispatcher.close();
    throw new Error('Keycloak did not become ready in 30 seconds.');
  }
  const bootstrapResponse = await fetch(
    `${publicUrl}/realms/master/protocol/openid-connect/token`,
    {
      method: 'POST',
      body: new URLSearchParams({
        client_id: 'admin-cli',
        grant_type: 'password',
        username: requiredTestEnv('KC_BOOTSTRAP_ADMIN_USERNAME'),
        password: requiredTestEnv('KC_BOOTSTRAP_ADMIN_PASSWORD'),
      }),
    },
  );
  if (!bootstrapResponse.ok)
    throw new Error(
      `Keycloak bootstrap token failed (${bootstrapResponse.status}).`,
    );
  const bootstrapToken = (
    (await bootstrapResponse.json()) as { access_token: string }
  ).access_token;
  const admin = async (path: string, init: RequestInit = {}) =>
    await fetch(`${publicUrl}${path}`, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: {
        'Content-Type': 'application/json',
        ...init.headers,
        Authorization: `Bearer ${bootstrapToken}`,
      },
    });
  const json = async <T>(path: string): Promise<T> => {
    const result = await admin(path);
    if (!result.ok)
      throw new Error(`Keycloak test fixture read failed (${result.status}).`);
    return (await result.json()) as T;
  };
  let creators = await json<{ id: string }[]>(
    `/admin/realms/master/clients?clientId=${CLIENT_IDS.realmCreator}`,
  );
  if (!creators.length) {
    const created = await admin('/admin/realms/master/clients', {
      method: 'POST',
      body: JSON.stringify({
        clientId: CLIENT_IDS.realmCreator,
        enabled: true,
        serviceAccountsEnabled: true,
        standardFlowEnabled: false,
        directAccessGrantsEnabled: false,
        publicClient: false,
        secret: requiredTestEnv(
          'JGW_MASTER_J_AUTH_REALM_CREATOR_CLIENT_SECRET',
        ),
        fullScopeAllowed: true,
      }),
    });
    if (created.status !== 201)
      throw new Error('Keycloak test fixture client creation failed.');
    creators = await json<{ id: string }[]>(
      `/admin/realms/master/clients?clientId=${CLIENT_IDS.realmCreator}`,
    );
  }
  const creator = creators[0];
  if (!creator) throw new Error('Missing test master client.');
  const user = await json<{ id: string }>(
    `/admin/realms/master/clients/${creator.id}/service-account-user`,
  );
  const adminRole = await json<{ id: string; name: string }>(
    '/admin/realms/master/roles/admin',
  );
  // This broad bootstrap role belongs only to this isolated fixture, not production runtime code.
  const mapped = await admin(
    `/admin/realms/master/users/${user.id}/role-mappings/realm`,
    { method: 'POST', body: JSON.stringify([adminRole]) },
  );
  if (mapped.status !== 204)
    throw new Error('Keycloak fixture admin role setup failed.');
  for (const tenantId of ['sample-a', 'sample-b', 'sample-c']) {
    const serviceKey = requiredTestEnv(
      `JGW_${tenantId.toUpperCase().replaceAll('-', '_')}_SERVICE_KEY`,
    );
    if (await tenants.findActive(tenantId)) continue;
    await tenants.reserve(tenantId);
    const realm = customerRealmName(tenantId);
    const allClients = await json<{ id: string; clientId: string }[]>(
      `/admin/realms/${realm}/clients`,
    );
    const allowed = new Set<string>([
      CLIENT_IDS.memberAdmin,
      CLIENT_IDS.provisioner,
      ...SERVICE_CATALOG.filter((s) => s.tenantService).map((s) => s.clientId),
    ]);
    const clients = [];
    for (const client of allClients.filter((c) => allowed.has(c.clientId))) {
      const roles = await json<{ name: string; id: string }[]>(
        `/admin/realms/${realm}/clients/${client.id}/roles`,
      );
      clients.push({
        clientId: client.clientId,
        keycloakId: client.id,
        roles: roles.map((role) => ({ name: role.name, keycloakId: role.id })),
      });
    }
    await tenants.activate(tenantId, hashServiceKey(serviceKey), clients);
  }
  const master = new KeycloakClient({
    baseUrl: publicUrl,
    realm: 'master',
    clientId: CLIENT_IDS.realmCreator,
    secret: async () =>
      requiredTestEnv('JGW_MASTER_J_AUTH_REALM_CREATOR_CLIENT_SECRET'),
    fetch,
  });
  const passwordToken = async (tenantId: string, username: string) => {
    const operator = tenantId === 'operator';
    const scope = tenantId.toUpperCase().replaceAll('-', '_');
    const clientId = operator ? CLIENT_IDS.console : CLIENT_IDS.groupware;
    const clientScope = clientId.toUpperCase().replaceAll('-', '_');
    const realm = operator ? 'operator' : customerRealmName(tenantId);
    const result = await fetch(
      `${publicUrl}/realms/${realm}/protocol/openid-connect/token`,
      {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'password',
          client_id: clientId,
          client_secret: requiredTestEnv(
            `JGW_${scope}_${clientScope}_CLIENT_SECRET`,
          ),
          username,
          password: requiredTestEnv(
            `JGW_${scope}_${username.toUpperCase().replaceAll('-', '_')}_PASSWORD`,
          ),
          scope: 'openid',
        }),
      },
    );
    if (!result.ok)
      throw new Error(`Sample token issuance failed (${result.status}).`);
    return (await result.json()) as {
      access_token: string;
      refresh_token: string;
      id_token: string;
    };
  };
  return {
    pool,
    tenants,
    publicUrl,
    fetch,
    admin,
    json,
    master,
    passwordToken,
    close: async () => {
      await pool.end();
      await dispatcher.close();
    },
  };
}

export type IntegrationRuntime = Awaited<ReturnType<typeof integrationRuntime>>;
