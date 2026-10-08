import { CLIENT_IDS, SERVICE_CATALOG } from '@j-auth/contracts';
import type { TenantServicesResponse } from '@j-auth/contracts';
import type { TenantStore } from '../db/tenants.js';
import { ApiError, unavailable } from '../errors.js';
import { keycloakSegment } from './client.js';
import type { RealmCredentials, KeycloakClient } from './client.js';
import { configureMemberAdmin } from './admin-permissions.js';
import {
  customerTemplate,
  readKeycloak,
  changeKeycloak,
  realmPrefix,
  realmClients,
  snapshotClients,
} from './realm-model.js';
import type { KcRole, KcMapper } from './realm-model.js';

export class SubscriptionService {
  constructor(
    private readonly tenants: TenantStore,
    private readonly credentials: RealmCredentials,
  ) {}

  private async context(tenantId: string) {
    if (!(await this.tenants.findActive(tenantId)))
      throw new ApiError(404, 'not_found', 'Tenant not found.');
    return {
      client: this.credentials.client(tenantId, 'provisioner'),
      prefix: realmPrefix(tenantId),
    };
  }

  private async services(
    client: KeycloakClient,
    tenantId: string,
  ): Promise<TenantServicesResponse> {
    const clients = await realmClients(client, tenantId);
    return {
      tenantId,
      services: SERVICE_CATALOG.filter(
        (s) =>
          s.tenantService && clients.some((c) => c.clientId === s.clientId),
      ).map((s) => s.serviceId) as TenantServicesResponse['services'],
    };
  }

  async list(tenantId: string): Promise<TenantServicesResponse> {
    return await this.tenants.withLock(tenantId, async () => {
      const { client } = await this.context(tenantId);
      return await this.services(client, tenantId);
    });
  }

  async change(
    tenantId: string,
    serviceId: string,
    enabled: boolean,
  ): Promise<TenantServicesResponse> {
    const service = SERVICE_CATALOG.find(
      (s) => s.serviceId === serviceId && s.tenantService && !s.required,
    );
    if (!service) {
      throw new ApiError(
        400,
        'invalid_input',
        'Select an optional tenant service.',
      );
    }
    return await this.tenants.withLock(tenantId, async () => {
      const { client, prefix } = await this.context(tenantId);
      const template = await customerTemplate(tenantId, [serviceId]);
      const definition = template.clients.find(
        (c) => c.clientId === service.clientId,
      )!;
      let clients = await realmClients(client, tenantId);
      const login = clients.find((c) => c.clientId === CLIENT_IDS.groupware);
      if (!login?.id) throw unavailable();
      let target = clients.find((c) => c.clientId === service.clientId);
      if (enabled) {
        if (!target) {
          await changeKeycloak(client, `${prefix}/clients`, 'POST', definition);
          clients = await realmClients(client, tenantId);
          target = clients.find((c) => c.clientId === service.clientId);
        }
        if (!target?.id) throw unavailable();
        const targetPath = `${prefix}/clients/${keycloakSegment(target.id)}`;
        await changeKeycloak(client, targetPath, 'PUT', {
          ...definition,
          id: target.id,
        });
        for (const role of service.roles) {
          const found = await client.request(
            `${targetPath}/roles/${keycloakSegment(role.name)}`,
          );
          if (found.status === 404)
            await changeKeycloak(client, `${targetPath}/roles`, 'POST', {
              name: role.name,
            });
          else if (!found.ok) throw unavailable();
        }
        const roles = await readKeycloak<KcRole[]>(
          client,
          `${targetPath}/roles`,
        );
        for (const definition of service.roles) {
          const rolePath = `${targetPath}/roles/${keycloakSegment(definition.name)}/composites`;
          const current = await readKeycloak<KcRole[]>(client, rolePath);
          const desired = definition.implies.map((name) =>
            roles.find((r) => r.name === name)!,
          );
          if (desired.some((r) => !r)) throw unavailable();
          const stale = current.filter(
            (r) => !desired.some((d) => d.id === r.id),
          );
          if (stale.length)
            await changeKeycloak(client, rolePath, 'DELETE', stale);
          if (desired.length)
            await changeKeycloak(client, rolePath, 'POST', desired);
        }
        const mapped = service.roles.map((d) =>
          roles.find((r) => r.name === d.name)!,
        );
        if (mapped.some((r) => !r)) throw unavailable();
        await changeKeycloak(
          client,
          `${prefix}/roles/tenant:admin/composites`,
          'POST',
          mapped,
        );
        await changeKeycloak(
          client,
          `${prefix}/clients/${keycloakSegment(login.id)}/scope-mappings/clients/${keycloakSegment(target.id)}`,
          'POST',
          mapped,
        );
        const desiredMappers = template.clients
          .find((c) => c.clientId === CLIENT_IDS.groupware)!
          .protocolMappers!.filter(
            (m) =>
              m.name === `client-roles-${serviceId}` ||
              m.name === `audience-${serviceId}`,
          );
        const mapperPath = `${prefix}/clients/${keycloakSegment(login.id)}/protocol-mappers/models`;
        const currentMappers = await readKeycloak<KcMapper[]>(
          client,
          mapperPath,
        );
        for (const mapper of desiredMappers) {
          const existing = currentMappers.filter((m) => m.name === mapper.name);
          // Repair duplicate managed mapper names before converging the canonical mapper.
          for (const duplicate of existing.slice(1))
            await changeKeycloak(
              client,
              `${mapperPath}/${keycloakSegment(duplicate.id!)}`,
              'DELETE',
            );
          await changeKeycloak(
            client,
            existing[0]
              ? `${mapperPath}/${keycloakSegment(existing[0].id!)}`
              : mapperPath,
            existing[0] ? 'PUT' : 'POST',
            { ...mapper, ...(existing[0] ? { id: existing[0].id } : {}) },
          );
        }
        await configureMemberAdmin(client, tenantId);
      } else {
        // Withdraw FGAP grants before removing references or deleting the role client.
        await configureMemberAdmin(client, tenantId, [serviceId]);
        const mapperPath = `${prefix}/clients/${keycloakSegment(login.id)}/protocol-mappers/models`;
        const mappers = await readKeycloak<KcMapper[]>(client, mapperPath);
        for (const mapper of mappers.filter(
          (m) =>
            m.name === `client-roles-${serviceId}` ||
            m.name === `audience-${serviceId}`,
        ))
          await changeKeycloak(
            client,
            `${mapperPath}/${keycloakSegment(mapper.id!)}`,
            'DELETE',
          );
        if (target?.id) {
          const targetPath = `${prefix}/clients/${keycloakSegment(target.id)}`;
          const roles = await readKeycloak<KcRole[]>(
            client,
            `${targetPath}/roles`,
          );
          if (roles.length) {
            await changeKeycloak(
              client,
              `${prefix}/clients/${keycloakSegment(login.id)}/scope-mappings/clients/${keycloakSegment(target.id)}`,
              'DELETE',
              roles,
            );
            await changeKeycloak(
              client,
              `${prefix}/roles/tenant:admin/composites`,
              'DELETE',
              roles,
            );
          }
          await changeKeycloak(client, targetPath, 'DELETE');
        }
      }
      await this.tenants.syncClients(
        tenantId,
        await snapshotClients(client, tenantId),
      );
      return await this.services(client, tenantId);
    });
  }
}
