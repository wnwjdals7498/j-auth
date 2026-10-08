import { describe, it, expect } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { KeycloakClient } from '../../apps/server/src/keycloak/client.js';
import { integrationRuntime } from './runtime.js';

describe('master realm creator minimum credential', () => {
  it('creates and reads secrets only in its own realm with create-realm alone', async () => {
    const runtime = await integrationRuntime();
    const name = `creator-${randomUUID()}`;
    const realm = `tenant-creator-${randomUUID().slice(0, 8)}`;
    const secret = randomBytes(32).toString('base64url');
    const realmSecret = randomBytes(32).toString('base64url');
    let id: string | undefined;
    try {
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
      id = (
        await runtime.json<{ id: string }[]>(
          `/admin/realms/master/clients?clientId=${name}`,
        )
      )[0]!.id;
      const user = await runtime.json<{ id: string }>(
        `/admin/realms/master/clients/${id}/service-account-user`,
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
      const creator = new KeycloakClient({
        baseUrl: runtime.publicUrl,
        realm: 'master',
        clientId: name,
        secret: async () => secret,
        fetch: runtime.fetch,
      });
      expect(
        (
          await creator.request('/admin/realms', {
            method: 'POST',
            body: JSON.stringify({
              realm,
              enabled: true,
              clients: [
                {
                  clientId: 'j-auth-admin',
                  enabled: true,
                  publicClient: false,
                  serviceAccountsEnabled: true,
                  secret: realmSecret,
                },
              ],
            }),
          })
        ).status,
      ).toBe(201);
      creator.clear(); // Realm creation assigns realm-specific admin roles; renew the cached token.
      const clients = await creator.request(
        `/admin/realms/${realm}/clients?clientId=j-auth-admin`,
      );
      expect(clients.status).toBe(200);
      const clientId = ((await clients.json()) as { id: string }[])[0]!.id;
      const credential = await creator.request(
        `/admin/realms/${realm}/clients/${clientId}/client-secret`,
      );
      expect(credential.status).toBe(200);
      expect(
        ((await credential.json()) as { value: string }).value === realmSecret,
      ).toBe(true);
      expect(
        (await creator.request('/admin/realms/tenant-sample-a/clients')).status,
      ).toBe(403);
    } finally {
      await runtime.admin(`/admin/realms/${realm}`, { method: 'DELETE' });
      if (id)
        await runtime.admin(`/admin/realms/master/clients/${id}`, {
          method: 'DELETE',
        });
      await runtime.close();
    }
  });
});
