import {
  CLIENT_IDS,
  SERVICE_CATALOG,
  customerRealmName,
} from '@j-auth/contracts';
import type { KeycloakClient } from './client.js';
import { keycloakSegment } from './client.js';
import { unavailable } from '../errors.js';

interface KcClient {
  id: string;
  clientId: string;
}
interface Role {
  id: string;
  name: string;
}
interface Policy {
  id: string;
  name: string;
}

// Run with realm bootstrap/provisioning credentials. Member APIs never call this.
export async function configureMemberAdmin(
  master: KeycloakClient,
  tenantId: string,
): Promise<void> {
  const realm = customerRealmName(tenantId);
  const prefix = `/admin/realms/${keycloakSegment(realm)}`;
  const read = async <T>(path: string): Promise<T> => {
    const response = await master.request(path);
    if (!response.ok) throw unavailable();
    try {
      return (await response.json()) as T;
    } catch {
      throw unavailable();
    }
  };
  const clients = await read<KcClient[]>(`${prefix}/clients`);
  const permissions = clients.find(
    (client) => client.clientId === 'admin-permissions',
  );
  const member = clients.find(
    (client) => client.clientId === CLIENT_IDS.memberAdmin,
  );
  if (!permissions || !member) throw unavailable();
  const user = await read<{ id: string }>(
    `${prefix}/clients/${keycloakSegment(member.id)}/service-account-user`,
  );
  const base = `${prefix}/clients/${keycloakSegment(permissions.id)}/authz/resource-server`;
  const policyName = 'j-auth-admin-service-account-policy';
  const policies = await read<Policy[]>(`${base}/policy`);
  const existingPolicy = policies.find((policy) => policy.name === policyName);
  const policyResponse = await master.request(
    `${base}/policy/user${existingPolicy ? `/${keycloakSegment(existingPolicy.id)}` : ''}`,
    {
      method: existingPolicy ? 'PUT' : 'POST',
      body: JSON.stringify({
        ...(existingPolicy ? { id: existingPolicy.id } : {}),
        name: policyName,
        logic: 'POSITIVE',
        users: [user.id],
      }),
    },
  );
  if (!policyResponse.ok) throw unavailable();
  const desired: {
    name: string;
    resourceType: string;
    scopes: string[];
    resources?: string[];
    policies: string[];
  }[] = [
    {
      name: 'j-auth-admin-manage-users',
      resourceType: 'Users',
      scopes: ['view', 'manage', 'map-roles'],
      policies: [policyName],
    },
  ];
  for (const service of SERVICE_CATALOG.filter(
    (service) => service.tenantService,
  )) {
    const client = clients.find(
      (client) => client.clientId === service.clientId,
    );
    if (!client) continue;
    desired.push({
      name: `j-auth-admin-view-${service.serviceId}`,
      resourceType: 'Clients',
      scopes: ['view'],
      resources: [client.id],
      policies: [policyName],
    });
    const roles = await read<Role[]>(
      `${prefix}/clients/${keycloakSegment(client.id)}/roles`,
    );
    for (const definition of service.roles.filter((role) => role.grantable)) {
      const role = roles.find((role) => role.name === definition.name);
      if (!role) throw unavailable();
      desired.push({
        name: `j-auth-admin-map-${role.name}`,
        resourceType: 'Roles',
        scopes: ['map-role'],
        resources: [role.id],
        policies: [policyName],
      });
    }
  }
  const current = await read<Policy[]>(`${base}/permission/scope`);
  const desiredNames = new Set(desired.map((permission) => permission.name));
  // Revoke obsolete grants first, so a failed update cannot leave stale service permissions.
  for (const permission of current.filter(
    (permission) =>
      permission.name.startsWith('j-auth-admin-') &&
      !desiredNames.has(permission.name),
  )) {
    if (
      !(
        await master.request(
          `${base}/permission/scope/${keycloakSegment(permission.id)}`,
          { method: 'DELETE' },
        )
      ).ok
    )
      throw unavailable();
  }
  for (const permission of desired) {
    const existing = current.find((entry) => entry.name === permission.name);
    const response = await master.request(
      `${base}/permission/scope${existing ? `/${keycloakSegment(existing.id)}` : ''}`,
      {
        method: existing ? 'PUT' : 'POST',
        body: JSON.stringify({
          ...permission,
          ...(existing ? { id: existing.id } : {}),
        }),
      },
    );
    if (!response.ok) throw unavailable();
  }
}
