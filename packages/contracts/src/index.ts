export interface ServiceRoleDefinition {
  readonly name: string;
  readonly implies: readonly string[];
  readonly grantable: boolean;
}

export interface ServiceCatalogEntry {
  readonly serviceId: string;
  readonly clientId: string;
  readonly audience: string;
  readonly required: boolean;
  readonly tenantService: boolean;
  readonly roles: readonly ServiceRoleDefinition[];
}

export const CLIENT_IDS = {
  groupware: "j-groupware",
  console: "j-console",
  memberAdmin: "j-auth-admin",
  provisioner: "j-auth-provisioner",
  realmCreator: "j-auth-realm-creator",
} as const;

export const IDENTITY_ROLES = {
  tenantAdmin: "tenant:admin",
  tenantMember: "tenant:member",
  operatorAdmin: "operator:admin",
} as const;

export const SERVICE_KEY_HEADER = "X-JGW-Service-Key" as const;

export const OIDC_PATHS = {
  login: "/auth/login",
  callback: "/auth/callback",
  logout: "/auth/logout",
  backchannelLogout: "/auth/backchannel-logout",
} as const;

export const TOKEN_POLICY = {
  algorithm: "RS256",
  issuerTemplate: "${KC_PUBLIC_URL}/realms/{realm}",
  jwksPathTemplate: "${issuer}/protocol/openid-connect/certs",
  claims: {
    issuer: "iss",
    authorizedParty: "azp",
    audience: "aud",
    tenant: "tenant",
  },
  authorizedParties: {
    tenant: CLIENT_IDS.groupware,
    operator: CLIENT_IDS.console,
  },
  accessTokenTtlSeconds: 300,
  sessionIdleSeconds: 1_800,
  sessionMaxSeconds: 28_800,
  refreshTokenMaxReuse: 0,
  revokeRefreshToken: true,
} as const;

export const API_ERROR_CODES = {
  invalidInput: "invalid_input",
  unauthenticated: "unauthenticated",
  forbidden: "forbidden",
  notFound: "not_found",
  conflict: "conflict",
  unavailable: "unavailable",
} as const;

export const SERVICE_CATALOG = [
  {
    serviceId: "j-groupware",
    clientId: CLIENT_IDS.groupware,
    audience: CLIENT_IDS.groupware,
    required: true,
    tenantService: true,
    roles: [
      { name: "board:read", implies: [], grantable: true },
      { name: "board:write", implies: ["board:read"], grantable: true },
      { name: "member:manage", implies: [], grantable: false },
      { name: "org:manage", implies: [], grantable: true },
    ],
  },
  {
    serviceId: "j-messenger",
    clientId: "j-messenger",
    audience: "j-messenger",
    required: false,
    tenantService: true,
    roles: [{ name: "messenger:use", implies: [], grantable: true }],
  },
  {
    serviceId: "j-mail",
    clientId: "j-mail",
    audience: "j-mail",
    required: false,
    tenantService: true,
    roles: [{ name: "mail:read", implies: [], grantable: true }],
  },
  {
    serviceId: "j-customer-auth-db",
    clientId: "j-customer-auth-db",
    audience: "j-customer-auth-db",
    required: false,
    tenantService: true,
    roles: [
      { name: "guest:read", implies: [], grantable: true },
      { name: "guest:write", implies: ["guest:read"], grantable: true },
    ],
  },
  {
    serviceId: "j-approval",
    clientId: "j-approval",
    audience: "j-approval",
    required: false,
    tenantService: true,
    roles: [{ name: "approval:use", implies: [], grantable: true }],
  },
  {
    serviceId: "j-talk",
    clientId: "j-talk",
    audience: "j-talk",
    required: false,
    tenantService: true,
    roles: [
      { name: "talk:read", implies: [], grantable: true },
      { name: "talk:write", implies: ["talk:read"], grantable: true },
    ],
  },
  {
    serviceId: "j-web",
    clientId: "j-web",
    audience: "j-web",
    required: false,
    tenantService: true,
    roles: [
      { name: "web:read", implies: [], grantable: true },
      { name: "web:write", implies: ["web:read"], grantable: true },
    ],
  },
  {
    serviceId: "j-console",
    clientId: CLIENT_IDS.console,
    audience: CLIENT_IDS.console,
    required: true,
    tenantService: false,
    roles: [
      { name: "customer:read", implies: [], grantable: false },
      { name: "customer:write", implies: ["customer:read"], grantable: false },
    ],
  },
] as const satisfies readonly ServiceCatalogEntry[];

export type ServiceCatalogItem = (typeof SERVICE_CATALOG)[number];
export type ServiceId = (typeof SERVICE_CATALOG)[number]["serviceId"];
export type TenantServiceId = Exclude<ServiceId, typeof CLIENT_IDS.console>;
export type OptionalTenantServiceId = Exclude<TenantServiceId, typeof CLIENT_IDS.groupware>;
export type FunctionalRoleName =
  (typeof SERVICE_CATALOG)[number]["roles"][number]["name"];

type TenantCatalogEntry = Extract<
  (typeof SERVICE_CATALOG)[number],
  { readonly tenantService: true }
>;

type GrantableRoleNames<Entry> = Entry extends {
  readonly roles: readonly (infer Role)[];
}
  ? Role extends {
      readonly name: infer Name extends string;
      readonly grantable: true;
    }
    ? Name
    : never
  : never;

export type CustomerGrantableRoleName = GrantableRoleNames<TenantCatalogEntry>;
export type AuthApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];

export interface AuthApiError {
  readonly code: AuthApiErrorCode;
  readonly message: string;
  readonly requestId: string;
}

export interface CreateMemberRequest {
  readonly username: string;
  readonly password: string;
  readonly roles: readonly CustomerGrantableRoleName[];
}

export interface MemberResponse {
  readonly id: string;
  readonly username: string;
  readonly enabled: boolean;
  readonly roles: readonly string[];
}

export interface MemberListResponse {
  readonly items: readonly MemberResponse[];
  readonly nextCursor: string | null;
}

export interface GrantableRolesResponse {
  readonly roles: readonly CustomerGrantableRoleName[];
}

export interface CreateTenantRequest {
  readonly tenantId: string;
  readonly adminUsername: string;
  readonly adminPassword: string;
}

export interface CreateTenantResponse {
  readonly clientSecret: string;
  readonly serviceKey: string;
}

export type RotateSecretsResponse = CreateTenantResponse;

export interface TenantServicesResponse {
  readonly tenantId: string;
  readonly services: readonly TenantServiceId[];
}

const CUSTOMER_TENANT_ID_PATTERN = /^[a-z][a-z0-9-]{2,30}$/;

function createRoleIndex(): ReadonlyMap<string, ServiceRoleDefinition> {
  const roles = new Map<string, ServiceRoleDefinition>();

  for (const service of SERVICE_CATALOG) {
    for (const role of service.roles) {
      if (roles.has(role.name)) {
        throw new Error(`Duplicate functional role name: ${role.name}`);
      }
      roles.set(role.name, role);
    }
  }

  for (const service of SERVICE_CATALOG) {
    const serviceRoleNames = new Set(service.roles.map((role) => role.name));
    for (const role of service.roles) {
      for (const impliedRole of role.implies) {
        if (!serviceRoleNames.has(impliedRole)) {
          throw new Error(
            `Role ${role.name} implies a role outside ${service.serviceId}: ${impliedRole}`,
          );
        }
      }
    }
  }

  return roles;
}

const ROLE_INDEX = createRoleIndex();
const TENANT_SERVICE_IDS = new Set<string>(
  SERVICE_CATALOG.filter((service) => service.tenantService).map(
    (service) => service.serviceId,
  ),
);
const OPTIONAL_TENANT_SERVICE_IDS = new Set<string>(
  SERVICE_CATALOG.filter((service) => service.tenantService && !service.required).map(
    (service) => service.serviceId,
  ),
);

export function assertCustomerTenantId(tenantId: string): asserts tenantId is string {
  const matchesTenantId =
    typeof tenantId === "string" &&
    CUSTOMER_TENANT_ID_PATTERN.exec(tenantId)?.[0] === tenantId;

  if (
    !matchesTenantId ||
    tenantId === "operator"
  ) {
    throw new TypeError("Invalid customer tenantId");
  }
}

export function customerRealmName(tenantId: string): string {
  assertCustomerTenantId(tenantId);
  return `tenant-${tenantId}`;
}

export function getTenantServices(
  selectedServiceIds: readonly string[] = [],
): readonly ServiceCatalogItem[] {
  const selected = new Set<string>();

  for (const serviceId of selectedServiceIds) {
    if (!TENANT_SERVICE_IDS.has(serviceId)) {
      throw new TypeError(`Unknown or non-tenant service: ${serviceId}`);
    }
    selected.add(serviceId);
  }

  return SERVICE_CATALOG.filter(
    (service) =>
      service.tenantService &&
      (service.required || selected.has(service.serviceId)),
  );
}

export function expandFunctionalRoles(
  roles: readonly string[],
): string[] {
  const expanded: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  const visit = (name: string): void => {
    const role = ROLE_INDEX.get(name);
    if (role === undefined) {
      throw new TypeError(`Unknown functional role: ${name}`);
    }
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`Functional role implication cycle: ${name}`);

    visiting.add(name);
    expanded.push(name);
    for (const impliedRole of role.implies) visit(impliedRole);
    visiting.delete(name);
    visited.add(name);
  };

  for (const role of roles) visit(role);
  return expanded;
}

export function getTenantAdminRoles(
  selectedServiceIds: readonly string[] = [],
): string[] {
  const functionalRoles = getTenantServices(selectedServiceIds).flatMap(
    (service) => service.roles.map((role) => role.name),
  );

  return [
    IDENTITY_ROLES.tenantAdmin,
    ...expandFunctionalRoles(functionalRoles),
  ];
}

export function getGrantableRoles(
  selectedServiceIds: readonly string[] = [],
): string[] {
  return getTenantServices(selectedServiceIds).flatMap((service) =>
    service.roles
      .filter((role) => role.grantable)
      .map((role) => role.name),
  );
}

function encodePathSegment(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim().length === 0 ||
    value === "." ||
    value === ".." ||
    /[\u0000-\u001F\u007F-\u009F]/u.test(value)
  ) {
    throw new TypeError(`Invalid ${label}`);
  }

  try {
    return encodeURIComponent(value);
  } catch {
    throw new TypeError(`Invalid ${label}`);
  }
}

function assertGrantableCustomerRole(
  role: string,
): asserts role is CustomerGrantableRoleName {
  const grantable = SERVICE_CATALOG.some(
    (service) =>
      service.tenantService &&
      service.roles.some((entry) => entry.grantable && entry.name === role),
  );

  if (!grantable) throw new TypeError(`Role is not customer-grantable: ${role}`);
}

function assertOptionalTenantServiceId(
  serviceId: string,
): asserts serviceId is OptionalTenantServiceId {
  if (!OPTIONAL_TENANT_SERVICE_IDS.has(serviceId)) {
    throw new TypeError(`Service cannot be changed for a customer tenant: ${serviceId}`);
  }
}

export const AUTH_API_PATHS = {
  members: "/auth/members",
  grantableRoles: "/auth/members/grantable-roles",
  member: (memberId: string): string =>
    `/auth/members/${encodePathSegment(memberId, "member id")}`,
  memberRole: (memberId: string, role: CustomerGrantableRoleName): string => {
    const encodedMemberId = encodePathSegment(memberId, "member id");
    assertGrantableCustomerRole(role);
    return `/auth/members/${encodedMemberId}/roles/${encodePathSegment(role, "role")}`;
  },
  tenants: "/auth/tenants",
  tenantServices: (tenantId: string): string => {
    assertCustomerTenantId(tenantId);
    return `/auth/tenants/${encodePathSegment(tenantId, "tenant id")}/services`;
  },
  tenantService: (
    tenantId: string,
    serviceId: OptionalTenantServiceId,
  ): string => {
    assertCustomerTenantId(tenantId);
    assertOptionalTenantServiceId(serviceId);
    return `/auth/tenants/${encodePathSegment(tenantId, "tenant id")}/services/${encodePathSegment(serviceId, "service id")}`;
  },
  rotateSecrets: (tenantId: string): string => {
    assertCustomerTenantId(tenantId);
    return `/auth/tenants/${encodePathSegment(tenantId, "tenant id")}/rotate-secrets`;
  },
} as const;
