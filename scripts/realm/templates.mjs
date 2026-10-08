const CUSTOMER_DOMAIN = '.jgw.test';
const CONSOLE_ORIGIN = 'https://console.jgw.test';
const KEYCLOAK_VERSION = '26.8.0';
const ENVIRONMENT_PREFIX = 'JGW_';

const FORBIDDEN_MEMBER_ADMIN_ROLES = [
  'manage-users',
  'view-clients',
  'realm-admin',
];

function assertContracts(contracts) {
  const required = [
    'SERVICE_CATALOG',
    'CLIENT_IDS',
    'IDENTITY_ROLES',
    'OIDC_PATHS',
    'TOKEN_POLICY',
    'assertCustomerTenantId',
    'customerRealmName',
    'getTenantServices',
    'getTenantAdminRoles',
    'getGrantableRoles',
  ];
  const missing = required.filter((name) => !(name in (contracts ?? {})));
  if (missing.length > 0) {
    throw new TypeError(`Shared contracts are missing: ${missing.join(', ')}`);
  }
}

function assertSelectedServices(selectedServiceIds) {
  if (!Array.isArray(selectedServiceIds)) {
    throw new TypeError('selectedServiceIds must be an array of service IDs.');
  }
}

function environmentKey(...labels) {
  const safeLabels = labels.map((label) => String(label)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, ''));
  return `${ENVIRONMENT_PREFIX}${safeLabels.join('_')}`;
}

function environmentPlaceholder(key) {
  if (!/^JGW_[A-Z0-9_]+$/.test(key)) {
    throw new TypeError('Generated Keycloak environment placeholder has an invalid key.');
  }
  return '${' + key + '}';
}

function clientSecretEnvironmentKey(scope, clientId) {
  return environmentKey(scope, clientId, 'client-secret');
}

function userPasswordEnvironmentKey(scope, username) {
  return environmentKey(scope, username, 'password');
}

function isJgwEnvironmentPlaceholder(value) {
  return typeof value === 'string' && /^\$\{JGW_[A-Z0-9_]+\}$/.test(value);
}

function loginClientSecretPlaceholder(scope, clientId) {
  return environmentPlaceholder(clientSecretEnvironmentKey(scope, clientId));
}

function userPasswordPlaceholder(scope, username) {
  return environmentPlaceholder(userPasswordEnvironmentKey(scope, username));
}

function serviceRoleClient(service) {
  return {
    clientId: service.clientId,
    name: service.clientId,
    enabled: true,
    clientAuthenticatorType: 'client-secret',
    redirectUris: [],
    webOrigins: [],
    bearerOnly: true,
    consentRequired: false,
    standardFlowEnabled: false,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false,
    publicClient: false,
    frontchannelLogout: false,
    protocol: 'openid-connect',
    fullScopeAllowed: false,
    defaultClientScopes: [],
    optionalClientScopes: [],
    attributes: {},
  };
}

function serviceAccountClient(environmentScope, clientId) {
  return {
    clientId,
    name: clientId,
    enabled: true,
    clientAuthenticatorType: 'client-secret',
    secret: loginClientSecretPlaceholder(environmentScope, clientId),
    redirectUris: [],
    webOrigins: [],
    bearerOnly: false,
    consentRequired: false,
    standardFlowEnabled: false,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: true,
    publicClient: false,
    frontchannelLogout: false,
    protocol: 'openid-connect',
    fullScopeAllowed: false,
    defaultClientScopes: [],
    optionalClientScopes: [],
    attributes: {},
  };
}

function roleMapper(name, protocolMapper, config) {
  return {
    name,
    protocol: 'openid-connect',
    protocolMapper,
    consentRequired: false,
    config,
  };
}

function buildProtocolMappers({ tenantId, services, contracts }) {
  const mappers = [
    roleMapper('subject', 'oidc-sub-mapper', {
      'access.token.claim': 'true',
      'introspection.token.claim': 'true',
    }),
    roleMapper('tenant-claim', 'oidc-hardcoded-claim-mapper', {
      'claim.name': contracts.TOKEN_POLICY.claims.tenant,
      'claim.value': tenantId,
      'jsonType.label': 'String',
      'access.token.claim': 'true',
      'id.token.claim': 'true',
      'userinfo.token.claim': 'true',
    }),
    roleMapper('preferred-username', 'oidc-usermodel-property-mapper', {
      'user.attribute': 'username',
      'claim.name': 'preferred_username',
      'jsonType.label': 'String',
      'access.token.claim': 'true',
      'id.token.claim': 'true',
      'userinfo.token.claim': 'true',
    }),
    roleMapper('realm-roles', 'oidc-usermodel-realm-role-mapper', {
      'claim.name': 'realm_access.roles',
      'jsonType.label': 'String',
      multivalued: 'true',
      'access.token.claim': 'true',
      'id.token.claim': 'false',
      'userinfo.token.claim': 'false',
    }),
  ];

  for (const service of services) {
    mappers.push(
      roleMapper(`client-roles-${service.serviceId}`, 'oidc-usermodel-client-role-mapper', {
        'usermodel.clientRoleMapping.clientId': service.clientId,
        'claim.name': 'resource_access.${client_id}.roles',
        'jsonType.label': 'String',
        multivalued: 'true',
        'access.token.claim': 'true',
        'id.token.claim': 'false',
        'userinfo.token.claim': 'false',
      }),
      roleMapper(`audience-${service.serviceId}`, 'oidc-audience-mapper', {
        'included.client.audience': service.audience,
        'access.token.claim': 'true',
        'id.token.claim': 'false',
      }),
    );
  }

  return mappers;
}

function loginClient({ clientId, environmentScope, origin, directGrants, tokenExchange, tenantId, services, contracts }) {
  const callback = `${origin}${contracts.OIDC_PATHS.callback}`;
  const backchannelLogout = `${origin}${contracts.OIDC_PATHS.backchannelLogout}`;
  const attributes = {
    'pkce.code.challenge.method': 'S256',
    'post.logout.redirect.uris': `${origin}/`,
    'backchannel.logout.url': backchannelLogout,
    'backchannel.logout.session.required': 'true',
  };

  if (tokenExchange) {
    attributes['standard.token.exchange.enabled'] = 'true';
  }

  return {
    clientId,
    name: clientId,
    enabled: true,
    clientAuthenticatorType: 'client-secret',
    secret: loginClientSecretPlaceholder(environmentScope, clientId),
    rootUrl: origin,
    baseUrl: origin,
    redirectUris: [callback],
    webOrigins: [origin],
    bearerOnly: false,
    consentRequired: false,
    standardFlowEnabled: true,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: directGrants,
    serviceAccountsEnabled: false,
    publicClient: false,
    frontchannelLogout: false,
    protocol: 'openid-connect',
    fullScopeAllowed: false,
    defaultClientScopes: ['web-origins'],
    optionalClientScopes: [],
    attributes,
    protocolMappers: buildProtocolMappers({ tenantId, services, contracts }),
  };
}

function roleRepresentation(service, role) {
  const roleNames = new Set(service.roles.map((entry) => entry.name));
  const invalidImplication = role.implies.find((name) => !roleNames.has(name));
  if (invalidImplication) {
    throw new TypeError(
      `Catalog role ${role.name} implies ${invalidImplication} outside ${service.serviceId}.`,
    );
  }

  if (role.implies.length === 0) {
    return { name: role.name };
  }

  return {
    name: role.name,
    composite: true,
    composites: {
      client: {
        [service.clientId]: [...role.implies],
      },
    },
  };
}

function clientRoleDefinitions(services) {
  return Object.fromEntries(
    services.map((service) => [
      service.clientId,
      service.roles.map((role) => roleRepresentation(service, role)),
    ]),
  );
}

function clientRoleCompositeMap(services, allowedRoleNames) {
  const allowed = new Set(allowedRoleNames);
  return Object.fromEntries(
    services.map((service) => [
      service.clientId,
      service.roles.map((role) => role.name).filter((name) => allowed.has(name)),
    ]),
  );
}

function customerScopeMappings({ loginClientId, services, identityRoles }) {
  return {
    scopeMappings: [
      {
        client: loginClientId,
        roles: [identityRoles.tenantAdmin, identityRoles.tenantMember],
      },
    ],
    // Keycloak keys identify the role owner; each entry names its scope consumer.
    clientScopeMappings: Object.fromEntries(services.map((service) => [
      service.clientId,
      [{ client: loginClientId, roles: service.roles.map((role) => role.name) }],
    ])),
  };
}

function makeUser(username, realmRole, environmentScope) {
  return {
    username,
    enabled: true,
    credentials: [
      {
        type: 'password',
        value: userPasswordPlaceholder(environmentScope, username),
        temporary: false,
      },
    ],
    realmRoles: [realmRole],
  };
}

// The member contract collects only username/password. Keycloak's default
// required email/name fields would add VERIFY_PROFILE at first login.
function userProfileComponents() {
  const profile = {
    attributes: [
      { name: 'username', validations: { length: { min: 1, max: 255 } },
        permissions: { view: ['admin', 'user'], edit: ['admin', 'user'] }, multivalued: false },
      ...['email', 'firstName', 'lastName'].map((name) => ({ name,
        permissions: { view: ['admin', 'user'], edit: ['admin', 'user'] }, multivalued: false })),
    ],
  };
  return { 'org.keycloak.userprofile.UserProfileProvider': [{
    providerId: 'declarative-user-profile',
    config: { 'kc.user.profile.config': [JSON.stringify(profile)] },
  }] };
}

function customerRealm({ tenantId, selectedServiceIds, services, directGrants, users, contracts }) {
  const clientIds = contracts.CLIENT_IDS;
  const identityRoles = contracts.IDENTITY_ROLES;
  const loginService = services.find((service) => service.clientId === clientIds.groupware);
  if (!loginService) {
    throw new TypeError('The shared service catalog is missing the required groupware service.');
  }

  const clientRoles = clientRoleDefinitions(services);
  const adminRoleNames = contracts.getTenantAdminRoles(selectedServiceIds).filter(
    (roleName) => roleName !== identityRoles.tenantAdmin,
  );
  const realmRoles = [
    {
      name: identityRoles.tenantAdmin,
      composite: true,
      composites: {
        client: clientRoleCompositeMap(services, adminRoleNames),
      },
    },
    { name: identityRoles.tenantMember },
  ];

  const origin = `https://gw.${tenantId}${CUSTOMER_DOMAIN}`;
  const login = loginClient({
    clientId: clientIds.groupware,
    environmentScope: tenantId,
    origin,
    directGrants,
    tokenExchange: true,
    tenantId,
    services,
    contracts,
  });
  const extraRoleClients = services
    .filter((service) => service.clientId !== clientIds.groupware)
    .map(serviceRoleClient);

  return {
    realm: contracts.customerRealmName(tenantId),
    components: userProfileComponents(),
    enabled: true,
    sslRequired: 'external',
    defaultSignatureAlgorithm: contracts.TOKEN_POLICY.algorithm,
    accessTokenLifespan: contracts.TOKEN_POLICY.accessTokenTtlSeconds,
    ssoSessionIdleTimeout: contracts.TOKEN_POLICY.sessionIdleSeconds,
    ssoSessionMaxLifespan: contracts.TOKEN_POLICY.sessionMaxSeconds,
    revokeRefreshToken: contracts.TOKEN_POLICY.revokeRefreshToken,
    refreshTokenMaxReuse: contracts.TOKEN_POLICY.refreshTokenMaxReuse,
    adminPermissionsEnabled: true,
    bruteForceProtected: true,
    registrationAllowed: false,
    registrationEmailAsUsername: false,
    loginWithEmailAllowed: true,
    duplicateEmailsAllowed: false,
    resetPasswordAllowed: false,
    rememberMe: false,
    verifyEmail: false,
    loginTheme: 'jgw',
    roles: {
      realm: realmRoles,
      client: clientRoles,
    },
    clients: [
      login,
      ...extraRoleClients,
      serviceAccountClient(tenantId, clientIds.memberAdmin),
      serviceAccountClient(tenantId, clientIds.provisioner),
    ],
    users,
    ...customerScopeMappings({
      loginClientId: clientIds.groupware,
      services,
      identityRoles,
    }),
  };
}

function getConsoleService(contracts) {
  const service = contracts.SERVICE_CATALOG.find(
    (entry) => entry.clientId === contracts.CLIENT_IDS.console && !entry.tenantService,
  );
  if (!service) {
    throw new TypeError('The shared service catalog is missing the operator console service.');
  }
  return service;
}

function operatorRealm(contracts) {
  const clientIds = contracts.CLIENT_IDS;
  const identityRoles = contracts.IDENTITY_ROLES;
  const service = getConsoleService(contracts);
  const origin = CONSOLE_ORIGIN;
  const login = loginClient({
    clientId: clientIds.console,
    environmentScope: 'operator',
    origin,
    directGrants: true,
    tokenExchange: false,
    tenantId: 'operator',
    services: [service],
    contracts,
  });
  const consoleRoles = service.roles.map((role) => role.name);

  return {
    realm: 'operator',
    components: userProfileComponents(),
    enabled: true,
    sslRequired: 'external',
    defaultSignatureAlgorithm: contracts.TOKEN_POLICY.algorithm,
    accessTokenLifespan: contracts.TOKEN_POLICY.accessTokenTtlSeconds,
    ssoSessionIdleTimeout: contracts.TOKEN_POLICY.sessionIdleSeconds,
    ssoSessionMaxLifespan: contracts.TOKEN_POLICY.sessionMaxSeconds,
    revokeRefreshToken: contracts.TOKEN_POLICY.revokeRefreshToken,
    refreshTokenMaxReuse: contracts.TOKEN_POLICY.refreshTokenMaxReuse,
    adminPermissionsEnabled: true,
    bruteForceProtected: true,
    registrationAllowed: false,
    registrationEmailAsUsername: false,
    loginWithEmailAllowed: true,
    duplicateEmailsAllowed: false,
    resetPasswordAllowed: false,
    rememberMe: false,
    verifyEmail: false,
    loginTheme: 'jgw',
    roles: {
      realm: [
        {
          name: identityRoles.operatorAdmin,
          composite: true,
          composites: {
            client: {
              [service.clientId]: consoleRoles,
            },
          },
        },
      ],
      client: clientRoleDefinitions([service]),
    },
    clients: [login],
    users: [makeUser('op-admin', identityRoles.operatorAdmin, 'operator')],
    scopeMappings: [
      {
        client: clientIds.console,
        roles: [identityRoles.operatorAdmin],
      },
    ],
    clientScopeMappings: {
      [clientIds.console]: [
        {
          client: service.clientId,
          roles: consoleRoles,
        },
      ],
    },
  };
}

export function buildCustomerRealm({ tenantId, selectedServiceIds = [] }, contracts) {
  assertContracts(contracts);
  contracts.assertCustomerTenantId(tenantId);
  assertSelectedServices(selectedServiceIds);
  const services = contracts.getTenantServices(selectedServiceIds);
  return customerRealm({
    tenantId,
    selectedServiceIds,
    services,
    directGrants: false,
    users: [],
    contracts,
  });
}

function optionalTenantServiceIds(contracts) {
  return contracts.SERVICE_CATALOG
    .filter((service) => service.tenantService && !service.required)
    .map((service) => service.serviceId);
}

const SAMPLE_USERS = {
  'sample-a': [
    ['a-admin', 'tenantAdmin'],
    ['a-member', 'tenantMember'],
  ],
  'sample-b': [
    ['b-admin', 'tenantAdmin'],
    ['b-member', 'tenantMember'],
  ],
  'sample-c': [['c-admin', 'tenantAdmin']],
};

function buildSampleCustomerRealm(tenantId, selectedServiceIds, contracts) {
  contracts.assertCustomerTenantId(tenantId);
  const services = contracts.getTenantServices(selectedServiceIds);
  const users = SAMPLE_USERS[tenantId].map(([username, roleKey]) =>
    makeUser(username, contracts.IDENTITY_ROLES[roleKey], tenantId),
  );
  return customerRealm({
    tenantId,
    selectedServiceIds,
    services,
    directGrants: true,
    users,
    contracts,
  });
}

export function buildSampleRealms(contracts) {
  assertContracts(contracts);
  const allOptionalServices = optionalTenantServiceIds(contracts);
  return [
    operatorRealm(contracts),
    buildSampleCustomerRealm('sample-a', allOptionalServices, contracts),
    buildSampleCustomerRealm('sample-b', allOptionalServices, contracts),
    buildSampleCustomerRealm('sample-c', [], contracts),
  ];
}

export function buildSampleRealm(name, contracts) {
  const realm = buildSampleRealms(contracts).find((entry) => entry.realm === name ||
    (name.startsWith('sample-') && entry.realm === contracts.customerRealmName(name)));
  if (!realm) {
    throw new TypeError(`Unknown sample realm: ${name}`);
  }
  return realm;
}

function permissionRequest({ name, resourceType, scopes, policies, resources }) {
  return {
    method: 'POST',
    path: '/admin/realms/{realm}/clients/{adminPermissionsClientUuid}/authz/resource-server/permission/scope',
    body: {
      name,
      resourceType,
      scopes,
      ...(resources ? { resources } : {}),
      policies: [policies],
    },
  };
}

export function buildCustomerBootstrapPlan({ tenantId, selectedServiceIds = [] }, contracts) {
  assertContracts(contracts);
  contracts.assertCustomerTenantId(tenantId);
  assertSelectedServices(selectedServiceIds);

  const clientIds = contracts.CLIENT_IDS;
  const identityRoles = contracts.IDENTITY_ROLES;
  const realm = contracts.customerRealmName(tenantId);
  const services = contracts.getTenantServices(selectedServiceIds);
  const grantableNames = new Set(contracts.getGrantableRoles(selectedServiceIds));
  const policyName = 'j-auth-admin-service-account-policy';
  const appOrigin = `https://gw.${tenantId}${CUSTOMER_DOMAIN}`;

  const roleAllowlist = services.flatMap((service) =>
    service.roles
      .filter((role) => role.grantable && grantableNames.has(role.name))
      .map((role) => ({
        serviceId: service.serviceId,
        clientId: service.clientId,
        roleName: role.name,
        clientUuid: `<resolve client UUID for ${service.clientId}>`,
        roleUuid: `<resolve role UUID for ${service.clientId}/${role.name}>`,
      })),
  );
  const clientAllowlist = services.map((service) => ({
    serviceId: service.serviceId,
    clientId: service.clientId,
    clientUuid: `<resolve client UUID for ${service.clientId}>`,
  }));

  const requests = [
    {
      method: 'GET',
      path: `/admin/realms/${realm}/clients?clientId=admin-permissions`,
      purpose: 'Resolve the client UUID created by adminPermissionsEnabled.',
    },
    {
      method: 'GET',
      path: `/admin/realms/${realm}/clients?clientId=${clientIds.memberAdmin}`,
      purpose: 'Resolve the j-auth-admin client UUID using a privileged bootstrap caller.',
    },
    {
      method: 'GET',
      path: `/admin/realms/${realm}/clients/{memberAdminClientUuid}/service-account-user`,
      purpose: 'Resolve the j-auth-admin service-account user UUID.',
    },
    {
      method: 'POST',
      path: '/admin/realms/{realm}/clients/{adminPermissionsClientUuid}/authz/resource-server/policy/user',
      purpose: 'Create the user policy for only the j-auth-admin service account.',
      body: {
        name: policyName,
        logic: 'POSITIVE',
        users: ['<j-auth-admin service-account user UUID>'],
      },
    },
    permissionRequest({
      name: 'j-auth-admin-manage-users',
      resourceType: 'Users',
      scopes: ['view', 'manage', 'map-roles'],
      policies: policyName,
    }),
    ...clientAllowlist.map((entry) => permissionRequest({
      name: `j-auth-admin-view-${entry.serviceId}`,
      resourceType: 'Clients',
      scopes: ['view'],
      resources: [entry.clientUuid],
      policies: policyName,
    })),
    ...roleAllowlist.map((entry) => permissionRequest({
      name: `j-auth-admin-map-${entry.roleName}`,
      resourceType: 'Roles',
      scopes: ['map-role'],
      resources: [entry.roleUuid],
      policies: policyName,
    })),
  ];

  return {
    format: 'j-auth-keycloak-bootstrap-plan/v1',
    targetKeycloakVersion: KEYCLOAK_VERSION,
    realm,
    status: 'plan-only-not-applied-or-verified',
    realmImport: {
      adminPermissionsEnabled: true,
      permissionConfigurationComplete: false,
    },
    environment: {
      requiredImportKeys: [
        clientSecretEnvironmentKey(tenantId, clientIds.groupware),
        clientSecretEnvironmentKey(tenantId, clientIds.memberAdmin),
        clientSecretEnvironmentKey(tenantId, clientIds.provisioner),
      ],
      requiredRuntimeKeys: [clientSecretEnvironmentKey('master', clientIds.realmCreator)],
      valuesResolved: false,
      actualImportPerformed: false,
    },
    applicationRoutes: {
      login: contracts.OIDC_PATHS.login,
      callback: `${appOrigin}${contracts.OIDC_PATHS.callback}`,
      logout: `${appOrigin}${contracts.OIDC_PATHS.logout}`,
      postLogoutRedirect: `${appOrigin}/`,
      backchannelLogout: `${appOrigin}${contracts.OIDC_PATHS.backchannelLogout}`,
    },
    tokenPolicy: {
      ...contracts.TOKEN_POLICY,
      issuer: contracts.TOKEN_POLICY.issuerTemplate.replace('{realm}', realm),
      jwksUri: contracts.TOKEN_POLICY.jwksPathTemplate.replace('${issuer}',
        contracts.TOKEN_POLICY.issuerTemplate.replace('{realm}', realm)),
      authorizedParty: contracts.TOKEN_POLICY.authorizedParties.tenant,
    },
    jAuthAdmin: {
      clientId: clientIds.memberAdmin,
      assignedRealmManagementRoles: [],
      forbiddenRealmManagementRoles: [...FORBIDDEN_MEMBER_ADMIN_ROLES],
      userScopes: ['view', 'manage', 'map-roles'],
      clientViewAllowlist: clientAllowlist,
      roleMapAllowlist: roleAllowlist,
    },
    jAuthProvisioner: {
      clientId: clientIds.provisioner,
      plannedRealmManagementRoles: ['manage-clients', 'manage-realm', 'view-clients'],
      status: 'pending-runtime-measurement',
    },
    masterRealmCreator: {
      realm: 'master',
      clientId: clientIds.realmCreator,
      plannedRealmRole: 'create-realm',
      status: 'pending-runtime-measurement',
    },
    requests,
    unmeasured: [
      'Resolve admin-permissions, service-account, client, and role UUIDs from a privileged bootstrap caller.',
      'Verify the exact 26.8.0 REST permission requests and import behavior against a running server.',
      'Verify user create, read, update, role mapping, deletion, and session termination for j-auth-admin.',
      'Verify each client view permission cannot read a client secret; no such guarantee is inferred from adminPermissionsEnabled.',
      'Verify that only the catalog grantable-role UUID allowlist can be mapped and tenant:admin remains denied.',
      'Measure the minimum j-auth-provisioner and master realm creator roles before assigning them.',
    ],
  };
}

export function buildSampleBootstrapPlan(sampleTenantId, contracts) {
  assertContracts(contracts);
  if (!Object.hasOwn(SAMPLE_USERS, sampleTenantId)) {
    throw new TypeError(`No customer bootstrap plan exists for sample: ${sampleTenantId}`);
  }
  const selectedServiceIds = sampleTenantId === 'sample-c'
    ? []
    : optionalTenantServiceIds(contracts);
  const plan = buildCustomerBootstrapPlan({ tenantId: sampleTenantId, selectedServiceIds }, contracts);
  return {
    ...plan,
    environment: {
      ...plan.environment,
      requiredImportKeys: [
        ...plan.environment.requiredImportKeys,
        ...SAMPLE_USERS[sampleTenantId].map(([username]) =>
          userPasswordEnvironmentKey(sampleTenantId, username)),
      ],
      valuesResolved: false,
      actualImportPerformed: false,
    },
  };
}

export function buildOperatorBootstrapPlan(contracts) {
  assertContracts(contracts);
  const clientIds = contracts.CLIENT_IDS;
  return {
    format: 'j-auth-keycloak-import-plan/v1',
    targetKeycloakVersion: KEYCLOAK_VERSION,
    realm: 'operator',
    status: 'plan-only-not-imported-or-verified',
    realmImport: {
      adminPermissionsEnabled: true,
      permissionConfigurationComplete: false,
    },
    environment: {
      requiredImportKeys: [
        clientSecretEnvironmentKey('operator', clientIds.console),
        userPasswordEnvironmentKey('operator', 'op-admin'),
      ],
      requiredRuntimeKeys: [clientSecretEnvironmentKey('master', clientIds.realmCreator)],
      valuesResolved: false,
      actualImportPerformed: false,
    },
    unmeasured: [
      'Provide the listed environment variables to Keycloak import; this generator never reads or resolves them.',
      'No Keycloak import or operator realm permission verification was run.',
    ],
  };
}

export function validateRealmImportStructure(realm, contracts) {
  assertContracts(contracts);
  const errors = [];
  if (!realm || typeof realm !== 'object' || typeof realm.realm !== 'string') {
    return ['Realm import must be an object with a realm name.'];
  }
  if (realm.adminPermissionsEnabled !== true) {
    errors.push('adminPermissionsEnabled must be true.');
  }
  if (realm.defaultSignatureAlgorithm !== contracts.TOKEN_POLICY.algorithm) {
    errors.push('Realm signature algorithm differs from TOKEN_POLICY.');
  }
  if (realm.accessTokenLifespan !== contracts.TOKEN_POLICY.accessTokenTtlSeconds ||
      realm.ssoSessionIdleTimeout !== contracts.TOKEN_POLICY.sessionIdleSeconds ||
      realm.ssoSessionMaxLifespan !== contracts.TOKEN_POLICY.sessionMaxSeconds ||
      realm.revokeRefreshToken !== contracts.TOKEN_POLICY.revokeRefreshToken ||
      realm.refreshTokenMaxReuse !== contracts.TOKEN_POLICY.refreshTokenMaxReuse) {
    errors.push('Realm token and session policy differs from TOKEN_POLICY.');
  }

  const clients = Array.isArray(realm.clients) ? realm.clients : [];
  const clientsById = new Map(clients.map((client) => [client.clientId, client]));
  for (const client of clients) {
    if (client.secret !== undefined &&
        !isJgwEnvironmentPlaceholder(client.secret)) {
      errors.push(`Client ${client.clientId} secret must be an unresolved JGW environment placeholder.`);
    }
    if (client.fullScopeAllowed !== false) {
      errors.push(`Client ${client.clientId} must have fullScopeAllowed=false.`);
    }
    if (client.bearerOnly === true &&
        (client.standardFlowEnabled !== false ||
         client.implicitFlowEnabled !== false ||
         client.directAccessGrantsEnabled !== false ||
         client.serviceAccountsEnabled !== false)) {
      errors.push(`Role-holder client ${client.clientId} has an authentication flow enabled.`);
    }
  }

  const loginClientId = realm.realm === 'operator'
    ? contracts.CLIENT_IDS.console
    : contracts.CLIENT_IDS.groupware;
  const login = clientsById.get(loginClientId);
  if (!login) {
    errors.push(`Login client ${loginClientId} is missing.`);
  } else {
    if (login.publicClient !== false || login.clientAuthenticatorType !== 'client-secret') {
      errors.push(`Login client ${loginClientId} must be confidential.`);
    }
    if (login.standardFlowEnabled !== true || login.implicitFlowEnabled !== false) {
      errors.push(`Login client ${loginClientId} has an unexpected browser flow configuration.`);
    }
    if (login.attributes?.['pkce.code.challenge.method'] !== 'S256') {
      errors.push(`Login client ${loginClientId} must require PKCE S256.`);
    }
    const preferredUsernameMapper = login.protocolMappers?.find(
      (mapper) => mapper.name === 'preferred-username',
    );
    const subjectMapper = login.protocolMappers?.find((mapper) => mapper.name === 'subject');
    if (subjectMapper?.protocolMapper !== 'oidc-sub-mapper' ||
        subjectMapper.config?.['access.token.claim'] !== 'true') {
      errors.push('Login client must map the subject into the access token.');
    }
    if (preferredUsernameMapper?.protocolMapper !== 'oidc-usermodel-property-mapper' ||
        preferredUsernameMapper.config?.['user.attribute'] !== 'username' ||
        preferredUsernameMapper.config?.['claim.name'] !== 'preferred_username' ||
        preferredUsernameMapper.config?.['access.token.claim'] !== 'true' ||
        preferredUsernameMapper.config?.['id.token.claim'] !== 'true' ||
        preferredUsernameMapper.config?.['userinfo.token.claim'] !== 'true') {
      errors.push('Login client must map username to preferred_username in access, ID, and UserInfo tokens.');
    }
    if (loginClientId === contracts.CLIENT_IDS.groupware &&
        login.attributes?.['standard.token.exchange.enabled'] !== 'true') {
      errors.push('j-groupware must enable standard token exchange with the client attribute.');
    }
  }

  for (const user of realm.users ?? []) {
    for (const credential of user.credentials ?? []) {
      if (credential.type === 'password' &&
          !isJgwEnvironmentPlaceholder(credential.value)) {
        errors.push(`User ${user.username} password must be an unresolved JGW environment placeholder.`);
      }
    }
  }

  const memberAdminId = contracts.CLIENT_IDS.memberAdmin;
  const hasMemberAdminMapping = (realm.scopeMappings ?? []).some(
    (mapping) => mapping.client === memberAdminId,
  ) || Object.hasOwn(realm.clientScopeMappings ?? {}, memberAdminId);
  if (hasMemberAdminMapping) {
    errors.push('j-auth-admin must not receive broad client or realm role scope mappings.');
  }

  return errors;
}

export const REALM_TEMPLATE_TARGET_VERSION = KEYCLOAK_VERSION;
