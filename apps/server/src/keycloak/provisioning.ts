import { CLIENT_IDS, assertCustomerTenantId } from '@j-auth/contracts';
import type {
  CreateTenantRequest,
  CreateTenantResponse,
} from '@j-auth/contracts';
import type { TenantStore } from '../db/tenants.js';
import { ApiError, unavailable } from '../errors.js';
import { generateServiceKey } from '../security/service-key.js';
import type { KeycloakClient } from './client.js';
import { keycloakSegment } from './client.js';
import { configureMemberAdmin } from './admin-permissions.js';
import {
  customerTemplate,
  configureProvisioner,
  realmPrefix,
  realmClients,
  snapshotClients,
  readKeycloak,
  changeKeycloak,
  PROVISIONER_MANAGEMENT_ROLES,
} from './realm-model.js';
import type { KcRole } from './realm-model.js';

export const SERVICE_KEY_OVERLAP_SECONDS = 300;
const OWNERSHIP_ATTRIBUTE = 'j-auth-provisioning-id';

export class TenantProvisioning {
  constructor(
    private readonly tenants: TenantStore,
    private readonly creator: KeycloakClient,
  ) {}

  async create(input: CreateTenantRequest): Promise<CreateTenantResponse> {
    assertCustomerTenantId(input.tenantId);
    const username = input.adminUsername.trim().toLowerCase();
    if (username.startsWith('service-account-'))
      throw new ApiError(
        400,
        'invalid_input',
        'Administrator username uses a reserved prefix.',
      );
    return await this.tenants.withLock(input.tenantId, async () => {
      const ownership = await this.tenants.beginCreation(
        input.tenantId,
        username,
      );
      if (!ownership)
        throw new ApiError(
          409,
          'conflict',
          'Tenant already active or bootstrap username differs.',
        );
      try {
        const prefix = realmPrefix(input.tenantId);
        this.creator.clear(); // Creation grants new realm-specific rights; a retry must renew them too.
        let realm = await this.creator.request(prefix);
        if (realm.status === 404) {
          const template = await customerTemplate(input.tenantId);
          template.attributes = {
            ...template.attributes,
            [OWNERSHIP_ATTRIBUTE]: ownership,
          };
          // Admin REST generates the three confidential secrets; import placeholders are never used here.
          for (const client of template.clients) delete client.secret;
          // Bootstrap the service account during the realm import. A master realm creator
          // can manage its new realm but cannot always map protected admin roles afterwards.
          template.users = [
            {
              username: `service-account-${CLIENT_IDS.provisioner}`,
              enabled: true,
              serviceAccountClientId: CLIENT_IDS.provisioner,
              clientRoles: {
                'realm-management': [...PROVISIONER_MANAGEMENT_ROLES],
              },
            },
          ];
          const created = await this.creator.request('/admin/realms', {
            method: 'POST',
            body: JSON.stringify(template),
          });
          this.creator.clear();
          if (created.status !== 201 && created.status !== 409)
            throw unavailable();
          realm = await this.creator.request(prefix);
        }
        if (realm.status === 403)
          throw new ApiError(
            409,
            'conflict',
            'Existing realm is not owned by this provisioning request.',
          );
        if (!realm.ok) throw unavailable();
        const state = (await realm.json()) as {
          attributes?: Record<string, string>;
        };
        if (state.attributes?.[OWNERSHIP_ATTRIBUTE] !== ownership)
          throw new ApiError(
            409,
            'conflict',
            'Existing realm is not owned by this provisioning request.',
          );

        const users = await readKeycloak<
          { id: string; username: string; enabled: boolean }[]
        >(
          this.creator,
          `${prefix}/users?username=${encodeURIComponent(username)}&exact=true&max=2`,
        );
        let user = users.find((u) => u.username === username);
        if (!user) {
          const created = await this.creator.request(`${prefix}/users`, {
            method: 'POST',
            body: JSON.stringify({
              username,
              enabled: true,
              requiredActions: [],
              credentials: [
                {
                  type: 'password',
                  value: input.adminPassword,
                  temporary: false,
                },
              ],
            }),
          });
          if (created.status === 400)
            throw new ApiError(
              400,
              'invalid_input',
              'Administrator data rejected.',
            );
          if (created.status !== 201) throw unavailable();
          const location = created.headers.get('location');
          if (!location) throw unavailable();
          const id = new URL(location).pathname.split('/').at(-1);
          if (!id) throw unavailable();
          user = { id, username, enabled: true };
        }
        if (!user.enabled)
          throw new ApiError(
            409,
            'conflict',
            'Bootstrap administrator is disabled.',
          );
        const role = await readKeycloak<KcRole>(
          this.creator,
          `${prefix}/roles/tenant:admin`,
        );
        await changeKeycloak(
          this.creator,
          `${prefix}/users/${keycloakSegment(user.id)}/role-mappings/realm`,
          'POST',
          [role],
        );
        await configureProvisioner(this.creator, input.tenantId);
        await configureMemberAdmin(this.creator, input.tenantId);
        const clients = await snapshotClients(this.creator, input.tenantId);
        const login = clients.find((c) => c.clientId === CLIENT_IDS.groupware)!;
        const secret = await readKeycloak<{ value?: unknown }>(
          this.creator,
          `${prefix}/clients/${keycloakSegment(login.keycloakId)}/client-secret`,
        );
        if (
          typeof secret.value !== 'string' ||
          !secret.value ||
          secret.value.startsWith('${')
        )
          throw unavailable();
        const service = generateServiceKey();
        await this.tenants.activate(input.tenantId, service.hash, clients);
        return { clientSecret: secret.value, serviceKey: service.serviceKey };
      } catch (error) {
        await this.tenants.markFailed(input.tenantId).catch(() => undefined);
        throw error;
      }
    });
  }

  async rotate(tenantId: string): Promise<CreateTenantResponse> {
    return await this.tenants.withLock(tenantId, async () => {
      if (!(await this.tenants.findActive(tenantId)))
        throw new ApiError(404, 'not_found', 'Tenant not found.');
      // Keep exactly two service-key hashes. Never evict the old customer's valid key during overlap.
      if (!(await this.tenants.canRotateKey(tenantId)))
        throw new ApiError(
          409,
          'conflict',
          'Service-key overlap is still active. Retry after it expires.',
        );
      const login = (await realmClients(this.creator, tenantId)).find(
        (c) => c.clientId === CLIENT_IDS.groupware,
      );
      if (!login?.id) throw unavailable();
      const service = generateServiceKey();
      let clientSecret: string;
      try {
        const response = await this.creator.request(
          `${realmPrefix(tenantId)}/clients/${keycloakSegment(login.id)}/client-secret`,
          { method: 'POST' },
        );
        if (!response.ok) throw unavailable();
        const secret = (await response.json()) as { value?: unknown };
        if (typeof secret.value !== 'string' || !secret.value)
          throw unavailable();
        clientSecret = secret.value;
      } catch {
        throw new ApiError(
          503,
          'unavailable',
          'Client secret rotation could not be confirmed. Service key was not updated. Retry rotation to recover.',
        );
      }
      try {
        if (
          !(await this.tenants.rotateKey(
            tenantId,
            service.hash,
            SERVICE_KEY_OVERLAP_SECONDS,
          ))
        )
          throw unavailable();
      } catch {
        throw new ApiError(
          503,
          'unavailable',
          'Client secret changed, but service-key update failed. Retry rotation to recover.',
        );
      }
      return { clientSecret, serviceKey: service.serviceKey };
    });
  }
}
