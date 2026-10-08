import {
  IDENTITY_ROLES,
  SERVICE_CATALOG,
  customerRealmName,
  getGrantableRoles,
} from '@j-auth/contracts';
import type { MemberResponse } from '@j-auth/contracts';
import type { TenantStore } from '../db/tenants.js';
import { ApiError, forbidden, unavailable } from '../errors.js';
import type { RealmCredentials, KeycloakClient } from './client.js';
import { keycloakSegment } from './client.js';

interface KcUser {
  id: string;
  username: string;
  enabled: boolean;
  serviceAccountClientId?: string;
}
interface Role {
  id: string;
  name: string;
}

export class MemberService {
  constructor(
    private readonly tenants: TenantStore,
    private readonly credentials: RealmCredentials,
  ) {}

  private context(tenantId: string) {
    return {
      client: this.credentials.client(tenantId, 'member'),
      prefix: `/admin/realms/${keycloakSegment(customerRealmName(tenantId))}`,
    };
  }

  private async read<T>(client: KeycloakClient, path: string): Promise<T> {
    const response = await client.request(path);
    if (response.status === 404)
      throw new ApiError(404, 'not_found', 'Member not found.');
    if (!response.ok) throw unavailable();
    try {
      return (await response.json()) as T;
    } catch {
      throw unavailable();
    }
  }

  private async user(tenantId: string, id: string): Promise<KcUser> {
    const { client, prefix } = this.context(tenantId);
    // FGAP hides protected service-account users; they are not member targets.
    const response = await client.request(
      `${prefix}/users/${keycloakSegment(id)}`,
    );
    if (response.status === 403 || response.status === 404)
      throw new ApiError(404, 'not_found', 'Member not found.');
    if (!response.ok) throw unavailable();
    let user: KcUser;
    try {
      user = (await response.json()) as KcUser;
    } catch {
      throw unavailable();
    }
    if (
      user.serviceAccountClientId ||
      user.username.startsWith('service-account-')
    )
      throw new ApiError(404, 'not_found', 'Member not found.');
    return user;
  }

  async grantableRoles(tenantId: string): Promise<string[]> {
    const ids = await this.tenants.serviceIds(tenantId);
    return getGrantableRoles(
      SERVICE_CATALOG.filter(
        (service) => service.tenantService && ids.includes(service.clientId),
      ).map((service) => service.serviceId),
    );
  }
  async profile(
    tenantId: string,
    id: string,
  ): Promise<Pick<MemberResponse, 'id' | 'username' | 'enabled'>> {
    const user = await this.user(tenantId, id);
    return { id: user.id, username: user.username, enabled: user.enabled };
  }

  private async effectiveRoles(
    tenantId: string,
    id: string,
  ): Promise<string[]> {
    const { client, prefix } = this.context(tenantId);
    const userPath = `${prefix}/users/${keycloakSegment(id)}/role-mappings`;
    const roles = new Set<string>();
    const realmRoles = await this.read<Role[]>(
      client,
      `${userPath}/realm/composite`,
    );
    for (const role of realmRoles) {
      if (Object.values(IDENTITY_ROLES).some((known) => known === role.name))
        roles.add(role.name);
    }
    const ids = await this.tenants.serviceIds(tenantId);
    for (const service of SERVICE_CATALOG.filter(
      (service) => service.tenantService && ids.includes(service.clientId),
    )) {
      const internalId = await this.tenants.clientId(
        tenantId,
        service.clientId,
      );
      if (!internalId) throw unavailable();
      const mapped = await this.read<Role[]>(
        client,
        `${userPath}/clients/${keycloakSegment(internalId)}/composite`,
      );
      for (const definition of service.roles) {
        if (mapped.some((role) => role.name === definition.name))
          roles.add(definition.name);
      }
    }
    return [...roles];
  }

  async list(
    tenantId: string,
    offset: number,
  ): Promise<{ items: MemberResponse[]; nextCursor: string | null }> {
    const { client, prefix } = this.context(tenantId);
    const users = await this.read<KcUser[]>(
      client,
      `${prefix}/users?first=${offset}&max=50&briefRepresentation=false`,
    );
    const items = [];
    for (const user of users.filter(
      (user) =>
        !user.serviceAccountClientId &&
        !user.username.startsWith('service-account-'),
    )) {
      items.push({
        id: user.id,
        username: user.username,
        enabled: user.enabled,
        roles: await this.effectiveRoles(tenantId, user.id),
      });
    }
    return {
      items,
      nextCursor: users.length === 50 ? String(offset + users.length) : null,
    };
  }

  private async allowedMapping(tenantId: string, role: string) {
    if (!(await this.grantableRoles(tenantId)).includes(role))
      throw forbidden();
    const mapping = await this.tenants.roleMapping(tenantId, role);
    if (!mapping) throw unavailable();
    return mapping;
  }

  private async logout(
    tenantId: string,
    id: string,
    partialMessage: string,
  ): Promise<void> {
    const { client, prefix } = this.context(tenantId);
    try {
      if (
        !(
          await client.request(
            `${prefix}/users/${keycloakSegment(id)}/logout`,
            { method: 'POST' },
          )
        ).ok
      )
        throw unavailable();
    } catch {
      throw new ApiError(503, 'unavailable', partialMessage);
    }
  }

  async create(
    tenantId: string,
    input: { username: string; password: string; roles: readonly string[] },
  ): Promise<MemberResponse> {
    if (input.username.trim().toLowerCase().startsWith('service-account-'))
      throw new ApiError(
        400,
        'invalid_input',
        'Username uses a reserved service-account prefix.',
      );
    const mappings = [];
    for (const role of new Set(input.roles))
      mappings.push({ role, ...(await this.allowedMapping(tenantId, role)) });
    const { client, prefix } = this.context(tenantId);
    const response = await client.request(`${prefix}/users`, {
      method: 'POST',
      body: JSON.stringify({
        username: input.username,
        enabled: true,
        requiredActions: [],
        credentials: [
          { type: 'password', value: input.password, temporary: false },
        ],
      }),
    });
    if (response.status === 409)
      throw new ApiError(409, 'conflict', 'Username already exists.');
    if (response.status === 400)
      throw new ApiError(400, 'invalid_input', 'Member data rejected.');
    if (response.status !== 201) throw unavailable();
    const location = response.headers.get('location');
    if (!location)
      throw new ApiError(
        503,
        'unavailable',
        'Member created, but confirmation failed.',
      );
    const id = new URL(location).pathname.split('/').at(-1)!;
    try {
      for (const mapping of mappings) {
        if (
          !(
            await client.request(
              `${prefix}/users/${keycloakSegment(id)}/role-mappings/clients/${keycloakSegment(mapping.clientId)}`,
              {
                method: 'POST',
                body: JSON.stringify([
                  { id: mapping.roleId, name: mapping.role },
                ]),
              },
            )
          ).ok
        )
          throw unavailable();
      }
    } catch {
      try {
        if (
          !(
            await client.request(`${prefix}/users/${keycloakSegment(id)}`, {
              method: 'DELETE',
            })
          ).ok
        )
          throw unavailable();
      } catch {
        throw new ApiError(
          503,
          'unavailable',
          'Member created, but role assignment and cleanup failed.',
        );
      }
      throw unavailable();
    }
    const user = await this.user(tenantId, id);
    return {
      id,
      username: user.username,
      enabled: user.enabled,
      roles: await this.effectiveRoles(tenantId, id),
    };
  }

  async changeRole(
    tenantId: string,
    id: string,
    role: string,
    grant: boolean,
  ): Promise<MemberResponse> {
    const mapping = await this.allowedMapping(tenantId, role);
    const user = await this.user(tenantId, id);
    const { client, prefix } = this.context(tenantId);
    const response = await client.request(
      `${prefix}/users/${keycloakSegment(id)}/role-mappings/clients/${keycloakSegment(mapping.clientId)}`,
      {
        method: grant ? 'POST' : 'DELETE',
        body: JSON.stringify([{ id: mapping.roleId, name: role }]),
      },
    );
    if (response.status === 403) throw forbidden();
    if (!response.ok) throw unavailable();
    await this.logout(
      tenantId,
      id,
      'Roles changed, but session termination failed. Retry the role operation.',
    );
    return {
      id,
      username: user.username,
      enabled: user.enabled,
      roles: await this.effectiveRoles(tenantId, id),
    };
  }

  async remove(tenantId: string, id: string, caller: string): Promise<void> {
    if (id === caller) throw forbidden();
    await this.user(tenantId, id);
    if (
      (await this.effectiveRoles(tenantId, id)).includes(
        IDENTITY_ROLES.tenantAdmin,
      )
    )
      throw forbidden();
    // Logout before deletion; Keycloak also removes the user's sessions on deletion.
    await this.logout(
      tenantId,
      id,
      'Session termination failed. Member was not deleted.',
    );
    const { client, prefix } = this.context(tenantId);
    const response = await client.request(
      `${prefix}/users/${keycloakSegment(id)}`,
      { method: 'DELETE' },
    );
    if (response.status === 404)
      throw new ApiError(404, 'not_found', 'Member not found.');
    if (!response.ok) throw unavailable();
  }
}
