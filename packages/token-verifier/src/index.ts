import {
  CLIENT_IDS,
  IDENTITY_ROLES,
  SERVICE_CATALOG,
  TOKEN_POLICY,
  customerRealmName,
} from '@j-auth/contracts';
import { createRemoteJWKSet, customFetch, errors, jwtVerify } from 'jose';
import type { JWTVerifyGetKey, JWTPayload } from 'jose';

export class TokenVerificationError extends Error {
  constructor(public readonly kind: 'invalid' | 'unavailable') {
    super(
      kind === 'invalid'
        ? 'Invalid bearer token.'
        : 'Token verification unavailable.',
    );
  }
}

export interface VerifiedIdentity {
  readonly tenantId: string;
  readonly subject: string;
  readonly roles: readonly string[];
  readonly claims: JWTPayload;
}

export interface TokenVerifierOptions {
  readonly publicUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  // A local cryptographic key resolver is useful for unit tests. Production uses JWKS.
  readonly keyResolver?: JWTVerifyGetKey;
  readonly maxCachedRealms?: number;
}

function rolesFromClaims(claims: JWTPayload): string[] {
  const roles = new Set<string>();
  const realm = claims.realm_access as { roles?: unknown } | undefined;
  if (Array.isArray(realm?.roles)) {
    for (const role of realm.roles) {
      if (Object.values(IDENTITY_ROLES).some((known) => known === role))
        roles.add(role);
    }
  }
  const clients = claims.resource_access as
    Record<string, { roles?: unknown }> | undefined;
  for (const service of SERVICE_CATALOG) {
    const assigned = clients?.[service.clientId]?.roles;
    if (!Array.isArray(assigned)) continue;
    for (const role of service.roles) {
      if (assigned.includes(role.name)) roles.add(role.name);
    }
  }
  return [...roles];
}

export function createTokenVerifier(options: TokenVerifierOptions) {
  const base = new URL(options.publicUrl);
  if (
    base.protocol !== 'https:' ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    (base.pathname !== '/' && base.pathname !== '')
  ) {
    throw new TypeError('publicUrl must be an HTTPS origin.');
  }
  const maxCachedRealms = options.maxCachedRealms ?? 100;
  if (!Number.isInteger(maxCachedRealms) || maxCachedRealms < 1) {
    throw new TypeError('maxCachedRealms must be a positive integer.');
  }
  const keys = new Map<string, JWTVerifyGetKey>();

  return {
    async verify(
      token: string,
      expected: { tenantId: string; audience: string },
    ): Promise<VerifiedIdentity> {
      if (
        typeof token !== 'string' ||
        token.length === 0 ||
        token.length > 16_384
      ) {
        throw new TokenVerificationError('invalid');
      }
      const realm =
        expected.tenantId === 'operator'
          ? 'operator'
          : customerRealmName(expected.tenantId);
      const issuer = `${base.origin}/realms/${realm}`;
      const authorizedParty =
        expected.tenantId === 'operator'
          ? CLIENT_IDS.console
          : CLIENT_IDS.groupware;
      let key = options.keyResolver ?? keys.get(issuer);
      if (!key) {
        key = createRemoteJWKSet(
          new URL(`${issuer}/protocol/openid-connect/certs`),
          {
            cacheMaxAge: 300_000,
            cooldownDuration: 1_000,
            timeoutDuration: 5_000,
            ...(options.fetch ? { [customFetch]: options.fetch } : {}),
          },
        );
        if (keys.size >= maxCachedRealms)
          keys.delete(keys.keys().next().value!);
        keys.set(issuer, key);
      } else if (keys.has(issuer)) {
        // Keep recently used realms when the bounded cache evicts an entry.
        keys.delete(issuer);
        keys.set(issuer, key);
      }
      try {
        const { payload } = await jwtVerify(token, key, {
          algorithms: [TOKEN_POLICY.algorithm],
          issuer,
          audience: expected.audience,
          requiredClaims: ['sub', 'exp', 'iat', 'iss', 'aud', 'azp', 'tenant'],
          clockTolerance: 0,
        });
        if (
          payload.tenant !== expected.tenantId ||
          payload.azp !== authorizedParty ||
          payload.typ !== 'Bearer' ||
          typeof payload.sub !== 'string' ||
          payload.sub.length === 0
        ) {
          throw new TokenVerificationError('invalid');
        }
        return {
          tenantId: expected.tenantId,
          subject: payload.sub,
          roles: rolesFromClaims(payload),
          claims: payload,
        };
      } catch (error) {
        if (error instanceof TokenVerificationError) throw error;
        if (
          error instanceof errors.JWTClaimValidationFailed ||
          error instanceof errors.JWTExpired ||
          error instanceof errors.JWTInvalid ||
          error instanceof errors.JWSInvalid ||
          error instanceof errors.JWSSignatureVerificationFailed ||
          error instanceof errors.JOSEAlgNotAllowed ||
          error instanceof errors.JOSENotSupported ||
          error instanceof errors.JWKSNoMatchingKey
        ) {
          throw new TokenVerificationError('invalid');
        }
        throw new TokenVerificationError('unavailable');
      }
    },
  };
}

export type TokenVerifier = ReturnType<typeof createTokenVerifier>;
