import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadContracts } from '../../scripts/realm/contracts-loader.mjs';
import {
  buildCustomerBootstrapPlan,
  buildCustomerRealm,
  buildOperatorBootstrapPlan,
  buildSampleBootstrapPlan,
  buildSampleRealm,
  buildSampleRealms,
  validateRealmImportStructure,
} from '../../scripts/realm/templates.mjs';

const contracts = await loadContracts();
const optionalServiceIds = contracts.SERVICE_CATALOG
  .filter((service) => service.tenantService && !service.required)
  .map((service) => service.serviceId);

function loginClient(realm, clientId) {
  const client = realm.clients.find((entry) => entry.clientId === clientId);
  assert.ok(client, `missing client ${clientId}`);
  return client;
}

function roleMap(realm, clientId) {
  return Object.fromEntries(realm.roles.client[clientId].map((role) => [role.name, role]));
}

function assertPlaceholderSecrets(realm) {
  for (const client of realm.clients) {
    if (Object.hasOwn(client, 'secret')) {
      assert.match(client.secret, /^\$\{JGW_[A-Z0-9_]+\}$/);
      assert.doesNotMatch(client.secret, /__PLACEHOLDER_/);
    }
  }
  for (const user of realm.users ?? []) {
    for (const credential of user.credentials ?? []) {
      assert.match(credential.value, /^\$\{JGW_[A-Z0-9_]+\}$/);
    }
  }
}

test('missing compiled contracts fails with a build prerequisite', async () => {
  await assert.rejects(
    loadContracts({ contractsPath: join(tmpdir(), 'missing-j-auth-contracts', 'dist', 'index.js') }),
    /Build the shared contracts first from j-auth/,
  );
});

test('customer realm structure comes from shared contracts and keeps login grants disabled', () => {
  const tenantId = 'north-branch-7';
  const realm = buildCustomerRealm({ tenantId, selectedServiceIds: optionalServiceIds }, contracts);
  const services = contracts.getTenantServices(optionalServiceIds);
  const groupware = loginClient(realm, contracts.CLIENT_IDS.groupware);

  assert.equal(realm.realm, contracts.customerRealmName(tenantId));
  assert.equal(realm.adminPermissionsEnabled, true);
  assert.equal(realm.defaultSignatureAlgorithm, contracts.TOKEN_POLICY.algorithm);
  assert.equal(realm.accessTokenLifespan, contracts.TOKEN_POLICY.accessTokenTtlSeconds);
  assert.equal(realm.ssoSessionIdleTimeout, contracts.TOKEN_POLICY.sessionIdleSeconds);
  assert.equal(realm.ssoSessionMaxLifespan, contracts.TOKEN_POLICY.sessionMaxSeconds);
  assert.equal(realm.revokeRefreshToken, contracts.TOKEN_POLICY.revokeRefreshToken);
  assert.equal(realm.refreshTokenMaxReuse, contracts.TOKEN_POLICY.refreshTokenMaxReuse);
  assert.equal(groupware.publicClient, false);
  assert.equal(groupware.standardFlowEnabled, true);
  assert.equal(groupware.directAccessGrantsEnabled, false);
  assert.equal(groupware.fullScopeAllowed, false);
  assert.equal(groupware.attributes['pkce.code.challenge.method'], 'S256');
  assert.equal(groupware.attributes['standard.token.exchange.enabled'], 'true');
  const preferredUsernameMapper = groupware.protocolMappers.find(
    (mapper) => mapper.name === 'preferred-username',
  );
  assert.equal(preferredUsernameMapper.protocolMapper, 'oidc-usermodel-property-mapper');
  assert.equal(preferredUsernameMapper.config['user.attribute'], 'username');
  assert.equal(preferredUsernameMapper.config['claim.name'], 'preferred_username');
  assert.equal(preferredUsernameMapper.config['access.token.claim'], 'true');
  assert.equal(preferredUsernameMapper.config['id.token.claim'], 'true');
  assert.equal(preferredUsernameMapper.config['userinfo.token.claim'], 'true');
  assert.deepEqual(groupware.redirectUris, [`https://gw.${tenantId}.jgw.test${contracts.OIDC_PATHS.callback}`]);
  assert.equal(groupware.attributes['backchannel.logout.url'],
    `https://gw.${tenantId}.jgw.test${contracts.OIDC_PATHS.backchannelLogout}`);
  assert.equal(groupware.attributes['post.logout.redirect.uris'], `https://gw.${tenantId}.jgw.test/`);
  assert.deepEqual(realm.users, []);
  const profile = JSON.parse(realm.components['org.keycloak.userprofile.UserProfileProvider'][0]
    .config['kc.user.profile.config'][0]);
  assert.deepEqual(profile.attributes.filter((attribute) => attribute.required), []);
  assert.equal(groupware.protocolMappers.find((mapper) => mapper.name === 'subject')?.protocolMapper, 'oidc-sub-mapper');

  assert.deepEqual(Object.keys(realm.roles.client).sort(), services.map((service) => service.clientId).sort());
  for (const service of services) {
    const generatedRoles = roleMap(realm, service.clientId);
    assert.deepEqual(Object.keys(generatedRoles).sort(), service.roles.map((role) => role.name).sort());
    for (const role of service.roles) {
      const generated = generatedRoles[role.name];
      if (role.implies.length > 0) {
        assert.equal(generated.composite, true);
        assert.deepEqual(generated.composites.client[service.clientId], [...role.implies]);
      } else {
        assert.notEqual(generated.composite, true);
      }
    }
  }

  const tenantAdmin = realm.roles.realm.find((role) => role.name === contracts.IDENTITY_ROLES.tenantAdmin);
  const expectedAdminRoles = contracts.getTenantAdminRoles(optionalServiceIds)
    .filter((role) => role !== contracts.IDENTITY_ROLES.tenantAdmin)
    .sort();
  assert.deepEqual(Object.values(tenantAdmin.composites.client).flat().sort(), expectedAdminRoles);

  const mappedAudiences = groupware.protocolMappers
    .filter((mapper) => mapper.protocolMapper === 'oidc-audience-mapper')
    .map((mapper) => mapper.config['included.client.audience']);
  assert.deepEqual(mappedAudiences, services.map((service) => service.audience));
  assert.equal(groupware.protocolMappers.find((mapper) => mapper.name === 'tenant-claim')
    .config['claim.name'], contracts.TOKEN_POLICY.claims.tenant);
  assert.deepEqual(realm.clientScopeMappings, Object.fromEntries(services.map((service) => [
    service.clientId,
    [{ client: contracts.CLIENT_IDS.groupware, roles: service.roles.map((role) => role.name) }],
  ])));

  const roleHolders = services
    .filter((service) => service.clientId !== contracts.CLIENT_IDS.groupware)
    .map((service) => loginClient(realm, service.clientId));
  for (const client of roleHolders) {
    assert.equal(client.bearerOnly, true);
    assert.equal(client.standardFlowEnabled, false);
    assert.equal(client.implicitFlowEnabled, false);
    assert.equal(client.directAccessGrantsEnabled, false);
    assert.equal(client.serviceAccountsEnabled, false);
  }

  assert.equal(validateRealmImportStructure(realm, contracts).length, 0);
  assertPlaceholderSecrets(realm);
});

test('sample realms have only sample direct grants and the six decision accounts', () => {
  const realms = buildSampleRealms(contracts);
  const byName = new Map(realms.map((realm) => [realm.realm, realm]));
  const operator = byName.get('operator');
  const sampleA = byName.get(contracts.customerRealmName('sample-a'));
  const sampleB = byName.get(contracts.customerRealmName('sample-b'));
  const sampleC = byName.get(contracts.customerRealmName('sample-c'));

  assert.equal(loginClient(operator, contracts.CLIENT_IDS.console).directAccessGrantsEnabled, true);
  assert.equal(loginClient(sampleA, contracts.CLIENT_IDS.groupware).directAccessGrantsEnabled, true);
  assert.equal(loginClient(sampleB, contracts.CLIENT_IDS.groupware).directAccessGrantsEnabled, true);
  assert.equal(loginClient(sampleC, contracts.CLIENT_IDS.groupware).directAccessGrantsEnabled, true);
  assert.equal(loginClient(operator, contracts.CLIENT_IDS.console).standardFlowEnabled, true);
  assert.equal(loginClient(sampleA, contracts.CLIENT_IDS.groupware).standardFlowEnabled, true);
  assert.equal(loginClient(operator, contracts.CLIENT_IDS.console).protocolMappers
    .find((mapper) => mapper.name === 'preferred-username').config['claim.name'], 'preferred_username');

  const allCustomerServices = contracts.getTenantServices(optionalServiceIds);
  const baseServices = contracts.getTenantServices([]);
  assert.deepEqual(Object.keys(sampleA.roles.client).sort(), allCustomerServices.map((service) => service.clientId).sort());
  assert.deepEqual(Object.keys(sampleB.roles.client).sort(), allCustomerServices.map((service) => service.clientId).sort());
  assert.deepEqual(Object.keys(sampleC.roles.client).sort(), baseServices.map((service) => service.clientId).sort());

  assert.deepEqual(operator.users.map((user) => [user.username, user.realmRoles[0]]), [
    ['op-admin', contracts.IDENTITY_ROLES.operatorAdmin],
  ]);
  assert.deepEqual(sampleA.users.map((user) => [user.username, user.realmRoles[0]]), [
    ['a-admin', contracts.IDENTITY_ROLES.tenantAdmin],
    ['a-member', contracts.IDENTITY_ROLES.tenantMember],
  ]);
  assert.deepEqual(sampleB.users.map((user) => [user.username, user.realmRoles[0]]), [
    ['b-admin', contracts.IDENTITY_ROLES.tenantAdmin],
    ['b-member', contracts.IDENTITY_ROLES.tenantMember],
  ]);
  assert.deepEqual(sampleC.users.map((user) => [user.username, user.realmRoles[0]]), [
    ['c-admin', contracts.IDENTITY_ROLES.tenantAdmin],
  ]);
  assert.equal([operator, sampleA, sampleB, sampleC].reduce((total, realm) => total + realm.users.length, 0), 6);

  for (const realm of realms) {
    assert.equal(validateRealmImportStructure(realm, contracts).length, 0);
    assertPlaceholderSecrets(realm);
  }
});

test('admin permission output is an unverified UUID-specific plan, not a completion claim', () => {
  const plan = buildCustomerBootstrapPlan({
    tenantId: 'sample-c',
    selectedServiceIds: [],
  }, contracts);
  const grantableNames = contracts.getGrantableRoles([]);
  const plannedRoleNames = plan.jAuthAdmin.roleMapAllowlist.map((entry) => entry.roleName);

  assert.equal(plan.status, 'plan-only-not-applied-or-verified');
  assert.equal(plan.realmImport.permissionConfigurationComplete, false);
  assert.equal(plan.environment.valuesResolved, false);
  assert.equal(plan.environment.actualImportPerformed, false);
  assert.ok(plan.environment.requiredImportKeys.every((key) => /^JGW_[A-Z0-9_]+$/.test(key)));
  assert.ok(plan.environment.requiredRuntimeKeys.every((key) => /^JGW_[A-Z0-9_]+$/.test(key)));
  assert.deepEqual(plannedRoleNames, grantableNames);
  assert.deepEqual(plan.jAuthAdmin.assignedRealmManagementRoles, []);
  assert.ok(plan.jAuthAdmin.forbiddenRealmManagementRoles.includes('manage-users'));
  assert.ok(plan.jAuthAdmin.forbiddenRealmManagementRoles.includes('view-clients'));
  assert.ok(plan.jAuthAdmin.roleMapAllowlist.every((entry) =>
    entry.roleUuid.startsWith('<resolve role UUID for ')));
  assert.ok(plan.requests.some((request) =>
    request.path.endsWith('/permission/scope') && request.body.resourceType === 'Roles'));
  assert.ok(plan.unmeasured.some((item) => item.includes('client secret')));
  assert.equal(plan.jAuthProvisioner.status, 'pending-runtime-measurement');
  assert.equal(plan.masterRealmCreator.clientId, contracts.CLIENT_IDS.realmCreator);
  assert.equal(plan.applicationRoutes.login, contracts.OIDC_PATHS.login);
  assert.equal(plan.applicationRoutes.logout, `https://gw.sample-c.jgw.test${contracts.OIDC_PATHS.logout}`);
  assert.match(plan.tokenPolicy.jwksUri, /protocol\/openid-connect\/certs$/);
});

test('sample-c bootstrap plan derives the default service set from contracts', () => {
  const plan = buildSampleBootstrapPlan('sample-c', contracts);
  const expectedClientIds = contracts.getTenantServices([]).map((service) => service.clientId);
  assert.deepEqual(plan.jAuthAdmin.clientViewAllowlist.map((entry) => entry.clientId), expectedClientIds);
  assert.equal(plan.environment.valuesResolved, false);
  assert.equal(plan.environment.actualImportPerformed, false);
  assert.ok(plan.environment.requiredImportKeys.includes('JGW_SAMPLE_C_C_ADMIN_PASSWORD'));
  assert.throws(() => buildSampleRealm('sample-x', contracts), /Unknown sample realm/);
});

test('operator import plan lists unresolved environment keys and records no import', () => {
  const plan = buildOperatorBootstrapPlan(contracts);
  assert.equal(plan.realm, 'operator');
  assert.equal(plan.environment.valuesResolved, false);
  assert.equal(plan.environment.actualImportPerformed, false);
  assert.ok(plan.environment.requiredImportKeys.includes('JGW_OPERATOR_J_CONSOLE_CLIENT_SECRET'));
  assert.ok(plan.environment.requiredImportKeys.includes('JGW_OPERATOR_OP_ADMIN_PASSWORD'));
});

test('tenant and service inputs stop at the contracts boundary', () => {
  assert.throws(
    () => buildCustomerRealm({ tenantId: 'operator', selectedServiceIds: [] }, contracts),
    /Invalid customer tenantId/,
  );
  assert.throws(
    () => buildCustomerRealm({ tenantId: 'ACME', selectedServiceIds: [] }, contracts),
    /Invalid customer tenantId/,
  );
  assert.throws(
    () => buildCustomerRealm({ tenantId: 'valid-tenant', selectedServiceIds: ['j-console'] }, contracts),
    /Unknown or non-tenant service/,
  );
  assert.throws(
    () => buildCustomerRealm({ tenantId: 'valid-tenant', selectedServiceIds: 'j-mail' }, contracts),
    /selectedServiceIds must be an array/,
  );
});

test('validator rejects resolved secrets and the old literal marker', () => {
  const realm = buildCustomerRealm({ tenantId: 'secret-check', selectedServiceIds: [] }, contracts);
  const groupware = loginClient(realm, contracts.CLIENT_IDS.groupware);
  groupware.secret = 'unexpected-real-secret';
  assert.ok(validateRealmImportStructure(realm, contracts)
    .some((error) => error.includes('unresolved JGW environment placeholder')));

  groupware.secret = '__PLACEHOLDER_CLIENT_SECRET__';
  assert.ok(validateRealmImportStructure(realm, contracts)
    .some((error) => error.includes('unresolved JGW environment placeholder')));
});
