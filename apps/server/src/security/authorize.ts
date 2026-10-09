import { CLIENT_IDS, assertCustomerTenantId } from '@j-auth/contracts';
import { TokenVerificationError } from '@j-auth/token-verifier';
import type { TokenVerifier, VerifiedIdentity } from '@j-auth/token-verifier';
import { decodeJwt } from 'jose';
import type { TenantStore } from '../db/tenants.js';
import { forbidden, unauthenticated, unavailable } from '../errors.js';
import { matchesServiceKey } from './service-key.js';

export function createAuthorizer(options: {
  tenants: TenantStore;
  verifier: TokenVerifier;
  consoleKeyHashes: readonly string[];
}) {
  return async function authorize(
    headers: { authorization?: string; serviceKey?: unknown },
    mode: 'member' | 'member-read' | 'talk-write' | 'operator',
  ): Promise<VerifiedIdentity> {
    const bearer = headers.authorization;
    if (
      typeof bearer !== 'string' ||
      !/^Bearer [^\s]+$/i.test(bearer) ||
      bearer.length > 16_400
    )
      throw unauthenticated();
    const token = bearer.slice(7);
    // Only route to a registered tenant before any JWKS access. Claims are still untrusted here.
    let tenantId: string;
    try {
      const claim = decodeJwt(token).tenant;
      if (typeof claim !== 'string') throw new Error();
      tenantId = claim;
      if (mode !== 'operator') assertCustomerTenantId(tenantId);
      else if (tenantId !== 'operator') throw new Error();
    } catch {
      throw unauthenticated();
    }
    let hashes: readonly string[];
    if (mode === 'operator') hashes = options.consoleKeyHashes;
    else {
      let tenant;
      try {
        tenant = await options.tenants.findActive(tenantId);
      } catch {
        throw unavailable();
      }
      if (!tenant) throw unauthenticated();
      hashes = tenant.keyHashes;
    }
    if (!matchesServiceKey(headers.serviceKey, hashes)) throw unauthenticated();
    let identity: VerifiedIdentity;
    try {
      identity = await options.verifier.verify(token, {
        tenantId,
        audience:
          mode === 'operator' ? CLIENT_IDS.console : CLIENT_IDS.groupware,
      });
    } catch (error) {
      if (error instanceof TokenVerificationError && error.kind === 'invalid')
        throw unauthenticated();
      throw unavailable();
    }
    const roles =
      mode === 'operator'
        ? ['customer:write']
        : mode === 'talk-write'
          ? ['talk:write']
          : mode === 'member-read'
            ? ['member:manage', 'org:manage']
            : ['member:manage'];
    if (!roles.some((role) => identity.roles.includes(role))) throw forbidden();
    return identity;
  };
}
