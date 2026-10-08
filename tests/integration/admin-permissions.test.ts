import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { CLIENT_IDS } from '@j-auth/contracts';
import { configureMemberAdmin } from '../../apps/server/src/keycloak/admin-permissions.js';
import { RealmCredentials } from '../../apps/server/src/keycloak/client.js';
import { integrationRuntime } from './runtime.js';
import type { IntegrationRuntime } from './runtime.js';
import type { KeycloakClient } from '../../apps/server/src/keycloak/client.js';

describe('real Keycloak FGAP v2 boundary', () => {
  let runtime: IntegrationRuntime;
  let memberAdmin: KeycloakClient;
  let memberId: string | undefined;
  beforeAll(async () => {
    runtime = await integrationRuntime();
    await configureMemberAdmin(runtime.master, 'sample-c');
    const credentials = new RealmCredentials({
      master: runtime.master,
      tenants: runtime.tenants,
      baseUrl: runtime.publicUrl,
      fetch: runtime.fetch,
    });
    memberAdmin = credentials.client('sample-c', 'member');
  });
  afterAll(async () => {
    if (runtime) {
      if (memberId)
        await runtime.admin(`/admin/realms/tenant-sample-c/users/${memberId}`, {
          method: 'DELETE',
        });
      await runtime.close();
    }
  });
  it('applies permissions idempotently without broad realm-management roles', async () => {
    await configureMemberAdmin(runtime.master, 'sample-c');
    const clientId = await runtime.tenants.clientId(
      'sample-c',
      CLIENT_IDS.memberAdmin,
    );
    const user = await runtime.json<{ id: string }>(
      `/admin/realms/tenant-sample-c/clients/${clientId}/service-account-user`,
    );
    const mappings = await runtime.json<{
      clientMappings?: Record<string, { mappings: { name: string }[] }>;
    }>(`/admin/realms/tenant-sample-c/users/${user.id}/role-mappings`);
    expect(mappings.clientMappings?.['realm-management']).toBeUndefined();
    const permissionClient = (
      await runtime.json<{ id: string }[]>(
        '/admin/realms/tenant-sample-c/clients?clientId=admin-permissions',
      )
    )[0]!;
    const permissions = await runtime.json<{ name: string }[]>(
      `/admin/realms/tenant-sample-c/clients/${permissionClient.id}/authz/resource-server/permission/scope`,
    );
    const names = permissions.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });
  it('creates, reads and terminates a user session with FGAP alone', async () => {
    const created = await memberAdmin.request(
      '/admin/realms/tenant-sample-c/users',
      {
        method: 'POST',
        body: JSON.stringify({
          username: `fgap-${randomUUID()}`,
          enabled: true,
        }),
      },
    );
    expect(created.status).toBe(201);
    memberId = new URL(created.headers.get('location')!).pathname
      .split('/')
      .at(-1)!;
    expect(
      (
        await memberAdmin.request(
          `/admin/realms/tenant-sample-c/users/${memberId}`,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await memberAdmin.request(
          `/admin/realms/tenant-sample-c/users/${memberId}`,
          { method: 'PUT', body: JSON.stringify({ enabled: false }) },
        )
      ).status,
    ).toBe(204);
    expect(
      (
        (await (
          await memberAdmin.request(
            `/admin/realms/tenant-sample-c/users/${memberId}`,
          )
        ).json()) as { enabled: boolean }
      ).enabled,
    ).toBe(false);
    expect(
      (
        await memberAdmin.request(
          `/admin/realms/tenant-sample-c/users/${memberId}`,
          { method: 'PUT', body: JSON.stringify({ enabled: true }) },
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await memberAdmin.request(
          `/admin/realms/tenant-sample-c/users/${memberId}/logout`,
          { method: 'POST' },
        )
      ).status,
    ).toBe(204);
  });
  it('maps only grantable client roles and rejects tenant:admin and member:manage', async () => {
    const clientId = await runtime.tenants.clientId(
      'sample-c',
      CLIENT_IDS.groupware,
    );
    const readRole = await runtime.json<{ id: string; name: string }>(
      `/admin/realms/tenant-sample-c/clients/${clientId}/roles/board:read`,
    );
    expect(
      (
        await memberAdmin.request(
          `/admin/realms/tenant-sample-c/users/${memberId}/role-mappings/clients/${clientId}`,
          { method: 'POST', body: JSON.stringify([readRole]) },
        )
      ).status,
    ).toBe(204);
    const manageRole = await runtime.json<{ id: string; name: string }>(
      `/admin/realms/tenant-sample-c/clients/${clientId}/roles/member:manage`,
    );
    expect(
      (
        await memberAdmin.request(
          `/admin/realms/tenant-sample-c/users/${memberId}/role-mappings/clients/${clientId}`,
          { method: 'POST', body: JSON.stringify([manageRole]) },
        )
      ).status,
    ).toBe(403);
    const adminRole = await runtime.json<{ id: string; name: string }>(
      '/admin/realms/tenant-sample-c/roles/tenant:admin',
    );
    expect(
      (
        await memberAdmin.request(
          `/admin/realms/tenant-sample-c/users/${memberId}/role-mappings/realm`,
          { method: 'POST', body: JSON.stringify([adminRole]) },
        )
      ).status,
    ).toBe(403);
  });
  it('permits client metadata but denies secret retrieval and realm-management roles', async () => {
    const clientId = await runtime.tenants.clientId(
      'sample-c',
      CLIENT_IDS.groupware,
    );
    expect(
      (
        await memberAdmin.request(
          `/admin/realms/tenant-sample-c/clients/${clientId}`,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await memberAdmin.request(
          `/admin/realms/tenant-sample-c/clients/${clientId}/client-secret`,
        )
      ).status,
    ).toBe(403);
    const management = (
      await runtime.json<{ id: string }[]>(
        '/admin/realms/tenant-sample-c/clients?clientId=realm-management',
      )
    )[0]!;
    const role = await runtime.json<{ id: string; name: string }>(
      `/admin/realms/tenant-sample-c/clients/${management.id}/roles/manage-users`,
    );
    expect(
      (
        await memberAdmin.request(
          `/admin/realms/tenant-sample-c/users/${memberId}/role-mappings/clients/${management.id}`,
          { method: 'POST', body: JSON.stringify([role]) },
        )
      ).status,
    ).toBe(403);
  });
  it('deletes a test user with FGAP alone', async () => {
    expect(
      (
        await memberAdmin.request(
          `/admin/realms/tenant-sample-c/users/${memberId}`,
          { method: 'DELETE' },
        )
      ).status,
    ).toBe(204);
    memberId = undefined;
  });
});
