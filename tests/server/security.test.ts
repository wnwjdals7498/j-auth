import { describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { JWTPayload } from 'jose';
import {
  createTokenVerifier,
  TokenVerificationError,
} from '@j-auth/token-verifier';
import {
  generateServiceKey,
  hashServiceKey,
  matchesServiceKey,
} from '../../apps/server/src/security/service-key.js';
import { loadServerConfig } from '../../apps/server/src/config.js';
import { keycloakSegment } from '../../apps/server/src/keycloak/client.js';

const pair = await generateKeyPair('RS256', { extractable: true });
const publicKey = {
  ...(await exportJWK(pair.publicKey)),
  kid: 'test-key',
  alg: 'RS256',
  use: 'sig',
};
const verifier = createTokenVerifier({
  publicUrl: 'https://auth.jgw.test:8443',
  keyResolver: createLocalJWKSet({ keys: [publicKey] }),
});
const defaults: JWTPayload = {
  iss: 'https://auth.jgw.test:8443/realms/tenant-sample-a',
  sub: 'member-id',
  exp: Math.floor(Date.now() / 1000) + 300,
  iat: Math.floor(Date.now() / 1000),
  azp: 'j-groupware',
  aud: ['j-groupware', 'j-mail'],
  tenant: 'sample-a',
  typ: 'Bearer',
  realm_access: { roles: ['tenant:admin', 'default-roles-tenant-sample-a'] },
  resource_access: {
    'j-groupware': { roles: ['member:manage', 'board:read'] },
    'foreign-client': { roles: ['customer:write'] },
  },
};
const expected = { tenantId: 'sample-a', audience: 'j-groupware' };
async function signed(
  changes: JWTPayload = {},
  algorithm = 'RS256',
): Promise<string> {
  return new SignJWT({ ...defaults, ...changes })
    .setProtectedHeader({ alg: algorithm, kid: 'test-key' })
    .sign(pair.privateKey);
}

describe('service keys', () => {
  it('uses only SHA-256 digests and accepts either overlap hash', () => {
    const current = generateServiceKey();
    const previous = generateServiceKey();
    expect(current.serviceKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(current.hash).toBe(hashServiceKey(current.serviceKey));
    expect(current.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      matchesServiceKey(current.serviceKey, [current.hash, previous.hash]),
    ).toBe(true);
    expect(
      matchesServiceKey(previous.serviceKey, [current.hash, previous.hash]),
    ).toBe(true);
    expect(matchesServiceKey(previous.serviceKey, [current.hash])).toBe(false);
  });
  it.each([undefined, '', [], 'x'.repeat(1025)])(
    'rejects malformed key input %#',
    (value) => {
      expect(matchesServiceKey(value, [hashServiceKey('key')])).toBe(false);
    },
  );
  it('rejects wrong keys and malformed hashes without timingSafeEqual length errors', () => {
    expect(
      matchesServiceKey('key', [
        'bad',
        'A'.repeat(64),
        '',
        hashServiceKey('other'),
      ]),
    ).toBe(false);
    expect(matchesServiceKey('key', [])).toBe(false);
  });
});

describe('signed token validation', () => {
  it('checks a genuine RSA signature and exposes only known role namespaces', async () => {
    const identity = await verifier.verify(await signed(), expected);
    expect(identity.subject).toBe('member-id');
    expect(identity.roles).toEqual([
      'tenant:admin',
      'board:read',
      'member:manage',
    ]);
  });
  it.each([
    { iss: 'https://evil.jgw.test/realms/tenant-sample-a' },
    { tenant: 'sample-b' },
    { azp: 'j-console' },
    { aud: 'j-mail' },
    { exp: 1 },
    { nbf: Math.floor(Date.now() / 1000) + 300 },
    { typ: 'ID' },
    { sub: '' },
  ])('rejects changed boundary claims %#', async (changes) => {
    await expect(
      verifier.verify(await signed(changes), expected),
    ).rejects.toMatchObject({ kind: 'invalid' });
  });
  it('rejects missing required claims and signature tampering', async () => {
    const noExpiry = { ...defaults };
    delete noExpiry.exp;
    const token = await new SignJWT(noExpiry)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .sign(pair.privateKey);
    await expect(verifier.verify(token, expected)).rejects.toMatchObject({
      kind: 'invalid',
    });
    const original = await signed();
    const segments = original.split('.');
    segments[1] = Buffer.from(
      JSON.stringify({ ...defaults, tenant: 'sample-b' }),
    ).toString('base64url');
    await expect(
      verifier.verify(segments.join('.'), expected),
    ).rejects.toMatchObject({ kind: 'invalid' });
  });
  it('allows only RS256 and matches the operator realm separately', async () => {
    const hmac = await new SignJWT(defaults)
      .setProtectedHeader({ alg: 'HS256' })
      .sign(new Uint8Array(32));
    await expect(verifier.verify(hmac, expected)).rejects.toMatchObject({
      kind: 'invalid',
    });
    const operator = await signed({
      iss: 'https://auth.jgw.test:8443/realms/operator',
      tenant: 'operator',
      azp: 'j-console',
      aud: 'j-console',
      resource_access: { 'j-console': { roles: ['customer:write'] } },
    });
    expect(
      (
        await verifier.verify(operator, {
          tenantId: 'operator',
          audience: 'j-console',
        })
      ).roles,
    ).toContain('customer:write');
    await expect(verifier.verify(operator, expected)).rejects.toMatchObject({
      kind: 'invalid',
    });
  });
  it('distinguishes an unavailable key source from an invalid token', async () => {
    const offline = createTokenVerifier({
      publicUrl: 'https://auth.jgw.test:8443',
      keyResolver: async () => {
        throw new TypeError('private transport detail');
      },
    });
    await expect(offline.verify(await signed(), expected)).rejects.toEqual(
      new TokenVerificationError('unavailable'),
    );
    await expect(verifier.verify('bad', expected)).rejects.toMatchObject({
      kind: 'invalid',
    });
  });
  it.each([
    () => new Response('Unavailable', { status: 503 }),
    () => new Response('invalid JSON', { status: 200 }),
  ])('classifies JWKS HTTP/JSON failures as an outage %#', async (response) => {
    const unavailableKeys = createTokenVerifier({
      publicUrl: 'https://auth.jgw.test:8443',
      fetch: async () => response(),
    });
    await expect(
      unavailableKeys.verify(await signed(), expected),
    ).rejects.toEqual(new TokenVerificationError('unavailable'));
  });
});

describe('external configuration', () => {
  const env = {
    JAUTH_DB_PASSWORD: 'private-db-password',
    JAUTH_TLS_CERTIFICATE: '/tmp/server.crt',
    JAUTH_TLS_KEY: '/tmp/server.key',
    KC_PUBLIC_URL: 'https://auth.jgw.test:8443',
    JGW_MASTER_J_AUTH_REALM_CREATOR_CLIENT_SECRET: 'private-client-secret',
    JAUTH_CONSOLE_KEY_HASH: hashServiceKey('console'),
  };
  it('pins the dedicated DB identity, HTTPS origin and loopback listener', () => {
    const config = loadServerConfig(env);
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(54231);
    expect(config.database.user).toBe('jauth');
    expect(config.database.database).toBe('jauth');
  });
  it.each([
    { JAUTH_PORT: '3001' },
    { JAUTH_PORT: '65536' },
    { JAUTH_PORT: '1x' },
    { JAUTH_DB_USER: 'postgres' },
    { JAUTH_DB_NAME: 'keycloak' },
    { KC_PUBLIC_URL: 'http://auth.jgw.test:8443' },
    { KC_PUBLIC_URL: 'https://x:secret@auth.jgw.test' },
    { JAUTH_CONSOLE_KEY_HASH: 'plaintext-console-secret' },
  ])(
    'rejects invalid runtime configuration without disclosing values %#',
    (override) => {
      expect(() => loadServerConfig({ ...env, ...override })).toThrow();
      try {
        loadServerConfig({ ...env, ...override });
      } catch (error) {
        expect(String(error)).not.toContain('private-db-password');
        expect(String(error)).not.toContain('private-client-secret');
        expect(String(error)).not.toContain('plaintext-console-secret');
      }
    },
  );
  it('rejects path normalization escapes in Keycloak identifiers', () => {
    expect(() => keycloakSegment('..')).toThrow();
    expect(() => keycloakSegment('.')).toThrow();
    expect(keycloakSegment('id/with/slash')).toBe('id%2Fwith%2Fslash');
  });
});
