import * as contracts from '@j-auth/contracts';
import type { TenantClientMapping } from '../db/tenants.js';
import type { KeycloakClient } from './client.js';
import { keycloakSegment } from './client.js';
import { unavailable } from '../errors.js';

export const PROVISIONER_MANAGEMENT_ROLES = [
  'manage-clients',
  'manage-realm',
] as const;

export interface KcRole {
  id: string;
  name: string;
}
export interface KcMapper {
  id?: string;
  name: string;
  protocol: string;
  protocolMapper: string;
  config: Record<string, string>;
}
export interface KcRealmClient {
  id?: string;
  clientId: string;
  secret?: string;
  protocolMappers?: KcMapper[];
  [property: string]: unknown;
}
export interface CustomerRealm {
  realm: string;
  clients: KcRealmClient[];
  attributes?: Record<string, string>;
  [property: string]: unknown;
}

export async function customerTemplate(
  tenantId: string,
  selectedServiceIds: readonly string[] = [],
): Promise<CustomerRealm> {
  // Both provisioning and the CLI use the same source template; compiled code keeps the same depth.
  const location = new URL(
    '../../../../scripts/realm/templates.mjs',
    import.meta.url,
  ).href;
  const module = (await import(location)) as {
    buildCustomerRealm: (
      input: { tenantId: string; selectedServiceIds: readonly string[] },
      source: typeof contracts,
    ) => CustomerRealm;
  };
  return module.buildCustomerRealm({ tenantId, selectedServiceIds }, contracts);
}

export function realmPrefix(tenantId: string): string {
  return `/admin/realms/${keycloakSegment(contracts.customerRealmName(tenantId))}`;
}

export async function readKeycloak<T>(
  client: KeycloakClient,
  path: string,
): Promise<T> {
  const response = await client.request(path);
  if (!response.ok) throw unavailable();
  try {
    return (await response.json()) as T;
  } catch {
    throw unavailable();
  }
}

export async function changeKeycloak(
  client: KeycloakClient,
  path: string,
  method: 'POST' | 'PUT' | 'DELETE',
  body?: unknown,
): Promise<void> {
  const response = await client.request(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw unavailable();
}

export async function realmClients(
  client: KeycloakClient,
  tenantId: string,
): Promise<KcRealmClient[]> {
  return await readKeycloak(client, `${realmPrefix(tenantId)}/clients`);
}

export async function snapshotClients(
  client: KeycloakClient,
  tenantId: string,
): Promise<TenantClientMapping[]> {
  const clients = await realmClients(client, tenantId);
  const selected = new Set<string>([
    contracts.CLIENT_IDS.memberAdmin,
    contracts.CLIENT_IDS.provisioner,
    ...contracts.SERVICE_CATALOG.filter((s) => s.tenantService).map(
      (s) => s.clientId,
    ),
  ]);
  const mappings: TenantClientMapping[] = [];
  for (const entry of clients.filter((c) => selected.has(c.clientId))) {
    if (!entry.id) throw unavailable();
    const roles = await readKeycloak<KcRole[]>(
      client,
      `${realmPrefix(tenantId)}/clients/${keycloakSegment(entry.id)}/roles`,
    );
    mappings.push({
      clientId: entry.clientId,
      keycloakId: entry.id,
      roles: roles.map((r) => ({ name: r.name, keycloakId: r.id })),
    });
  }
  for (const required of [
    contracts.CLIENT_IDS.groupware,
    contracts.CLIENT_IDS.memberAdmin,
    contracts.CLIENT_IDS.provisioner,
  ])
    if (!mappings.some((c) => c.clientId === required)) throw unavailable();
  return mappings;
}

export async function configureProvisioner(
  master: KeycloakClient,
  tenantId: string,
): Promise<void> {
  const prefix = realmPrefix(tenantId);
  const clients = await realmClients(master, tenantId);
  const provisioner = clients.find(
    (c) => c.clientId === contracts.CLIENT_IDS.provisioner,
  );
  const management = clients.find((c) => c.clientId === 'realm-management');
  if (!provisioner?.id || !management?.id) throw unavailable();
  const user = await readKeycloak<{ id: string }>(
    master,
    `${prefix}/clients/${keycloakSegment(provisioner.id)}/service-account-user`,
  );
  const roles = await Promise.all(
    PROVISIONER_MANAGEMENT_ROLES.map((name) =>
      readKeycloak<KcRole>(
        master,
        `${prefix}/clients/${keycloakSegment(management.id!)}/roles/${name}`,
      ),
    ),
  );
  const mappingPath = `${prefix}/users/${keycloakSegment(user.id)}/role-mappings/clients/${keycloakSegment(management.id)}`;
  const existing = await readKeycloak<KcRole[]>(master, mappingPath);
  const missing = roles.filter(
    (role) => !existing.some((entry) => entry.id === role.id),
  );
  if (missing.length)
    await changeKeycloak(master, mappingPath, 'POST', missing);
  await changeKeycloak(
    master,
    `${prefix}/clients/${keycloakSegment(provisioner.id)}/scope-mappings/clients/${keycloakSegment(management.id)}`,
    'POST',
    roles,
  );
}
