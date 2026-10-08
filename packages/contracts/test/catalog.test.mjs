import assert from "node:assert/strict";
import test from "node:test";

import {
  API_ERROR_CODES,
  AUTH_API_PATHS,
  CLIENT_IDS,
  IDENTITY_ROLES,
  OIDC_PATHS,
  SERVICE_CATALOG,
  SERVICE_KEY_HEADER,
  TOKEN_POLICY,
  assertCustomerTenantId,
  customerRealmName,
  expandFunctionalRoles,
  getGrantableRoles,
  getTenantAdminRoles,
  getTenantServices,
} from "../dist/index.js";

const roleNames = SERVICE_CATALOG.flatMap((service) =>
  service.roles.map((role) => role.name),
);

test("catalog defines unique functional roles and write roles imply matching reads", () => {
  assert.equal(new Set(roleNames).size, roleNames.length);

  for (const service of SERVICE_CATALOG) {
    for (const role of service.roles.filter((entry) => entry.name.endsWith(":write"))) {
      assert.ok(role.implies.includes(`${role.name.slice(0, -"write".length)}read`));
    }
  }
});

test("customer tenant identifiers follow the reserved-name and realm rules", () => {
  assert.doesNotThrow(() => assertCustomerTenantId("sample-a"));
  assert.equal(customerRealmName("sample-a"), "tenant-sample-a");
  assert.throws(() => assertCustomerTenantId("operator"), TypeError);
  assert.throws(() => assertCustomerTenantId("ab"), TypeError);
  assert.throws(() => assertCustomerTenantId("Upper-case"), TypeError);
  assert.throws(() => assertCustomerTenantId("sample-a\n"), TypeError);
  assert.throws(() => customerRealmName("bad tenant"), TypeError);
});

test("tenant service selection always includes the base service and collapses duplicates", () => {
  assert.deepEqual(
    getTenantServices(["j-talk", "j-mail", "j-talk"]).map((service) => service.serviceId),
    ["j-groupware", "j-mail", "j-talk"],
  );
  assert.deepEqual(
    getTenantServices(["j-groupware"]).map((service) => service.serviceId),
    ["j-groupware"],
  );
  assert.throws(() => getTenantServices(["j-unknown"]), TypeError);
  assert.throws(() => getTenantServices(["j-console"]), TypeError);
});

test("tenant admin roles are effective and grantable roles exclude protected roles", () => {
  const adminRoles = getTenantAdminRoles(["j-mail"]);
  assert.ok(adminRoles.includes(IDENTITY_ROLES.tenantAdmin));
  assert.ok(adminRoles.includes("board:read"));
  assert.ok(adminRoles.includes("board:write"));
  assert.ok(adminRoles.includes("member:manage"));
  assert.ok(adminRoles.includes("mail:read"));
  assert.ok(!adminRoles.includes("customer:read"));

  const grantable = getGrantableRoles(["j-mail"]);
  assert.ok(grantable.includes("board:read"));
  assert.ok(grantable.includes("board:write"));
  assert.ok(grantable.includes("mail:read"));
  assert.ok(!grantable.includes("member:manage"));
  assert.ok(!grantable.includes(IDENTITY_ROLES.tenantAdmin));
  assert.ok(!grantable.includes("customer:write"));
});

test("functional role expansion applies implications and rejects non-functional names", () => {
  assert.deepEqual(expandFunctionalRoles(["board:write", "talk:write", "board:write"]), [
    "board:write",
    "board:read",
    "talk:write",
    "talk:read",
  ]);
  assert.throws(() => expandFunctionalRoles(["tenant:admin"]), TypeError);
  assert.throws(() => expandFunctionalRoles(["unknown:read"]), TypeError);
});

test("authentication and OIDC constants match the contracts decisions", () => {
  assert.deepEqual(CLIENT_IDS, {
    groupware: "j-groupware",
    console: "j-console",
    memberAdmin: "j-auth-admin",
    provisioner: "j-auth-provisioner",
    realmCreator: "j-auth-realm-creator",
  });
  assert.equal(SERVICE_KEY_HEADER, "X-JGW-Service-Key");
  assert.deepEqual(OIDC_PATHS, {
    login: "/auth/login",
    callback: "/auth/callback",
    logout: "/auth/logout",
    backchannelLogout: "/auth/backchannel-logout",
  });
  assert.equal(TOKEN_POLICY.algorithm, "RS256");
  assert.equal(TOKEN_POLICY.claims.tenant, "tenant");
  assert.equal(TOKEN_POLICY.accessTokenTtlSeconds, 300);
  assert.equal(TOKEN_POLICY.sessionIdleSeconds, 1_800);
  assert.equal(TOKEN_POLICY.sessionMaxSeconds, 28_800);
});

test("management API paths encode dynamic identifiers and validate tenant scope", () => {
  assert.equal(AUTH_API_PATHS.members, "/auth/members");
  assert.equal(AUTH_API_PATHS.grantableRoles, "/auth/members/grantable-roles");
  assert.equal(AUTH_API_PATHS.tenants, "/auth/tenants");
  assert.equal(AUTH_API_PATHS.member("id/with space"), "/auth/members/id%2Fwith%20space");
  assert.equal(
    AUTH_API_PATHS.memberRole("member-1", "board:write"),
    "/auth/members/member-1/roles/board%3Awrite",
  );
  assert.equal(AUTH_API_PATHS.tenantServices("sample-a"), "/auth/tenants/sample-a/services");
  assert.equal(
    AUTH_API_PATHS.tenantService("sample-a", "j-mail"),
    "/auth/tenants/sample-a/services/j-mail",
  );
  assert.equal(
    AUTH_API_PATHS.rotateSecrets("sample-a"),
    "/auth/tenants/sample-a/rotate-secrets",
  );

  assert.throws(() => AUTH_API_PATHS.member(""), TypeError);
  assert.throws(() => AUTH_API_PATHS.member("member-1\n"), TypeError);
  assert.throws(() => AUTH_API_PATHS.memberRole("member-1", "member:manage"), TypeError);
  assert.throws(() => AUTH_API_PATHS.memberRole("member-1", "tenant:admin"), TypeError);
  assert.throws(() => AUTH_API_PATHS.memberRole("member-1", "tenant:member"), TypeError);
  assert.throws(() => AUTH_API_PATHS.memberRole("member-1", "operator:admin"), TypeError);
  assert.throws(() => AUTH_API_PATHS.memberRole("member-1", "customer:read"), TypeError);
  assert.throws(() => AUTH_API_PATHS.tenantServices("operator"), TypeError);
  assert.throws(() => AUTH_API_PATHS.tenantService("sample-a", "j-groupware"), TypeError);
  assert.throws(() => AUTH_API_PATHS.tenantService("sample-a", "j-console"), TypeError);
  assert.throws(() => AUTH_API_PATHS.tenantService("sample-a", "j-unknown"), TypeError);
});

test("member paths reject dot segments before URL normalization can escape the route", () => {
  assert.equal(
    new URL("/auth/members/..", "https://auth.jgw.test").pathname,
    "/auth/",
  );
  assert.throws(() => AUTH_API_PATHS.member("."), TypeError);
  assert.throws(() => AUTH_API_PATHS.member(".."), TypeError);
  assert.throws(() => AUTH_API_PATHS.member("   "), TypeError);
  assert.throws(() => AUTH_API_PATHS.member("\uD800"), TypeError);
});

test("management API errors use the agreed wire codes", () => {
  assert.deepEqual(API_ERROR_CODES, {
    invalidInput: "invalid_input",
    unauthenticated: "unauthenticated",
    forbidden: "forbidden",
    notFound: "not_found",
    conflict: "conflict",
    unavailable: "unavailable",
  });
});
