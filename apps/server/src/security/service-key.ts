import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function hashServiceKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function generateServiceKey(): { serviceKey: string; hash: string } {
  const serviceKey = randomBytes(32).toString('base64url');
  return { serviceKey, hash: hashServiceKey(serviceKey) };
}

export function matchesServiceKey(
  key: unknown,
  hashes: readonly string[],
): boolean {
  if (typeof key !== 'string' || key.length === 0 || key.length > 1024)
    return false;
  const actual = Buffer.from(hashServiceKey(key), 'hex');
  let matched = 0;
  // Evaluate every hash, including the previous key, without an early return.
  for (const hash of hashes) {
    const valid = /^[a-f0-9]{64}$/.test(hash);
    const candidate = valid ? Buffer.from(hash, 'hex') : Buffer.alloc(32);
    matched |= Number(timingSafeEqual(actual, candidate)) & Number(valid);
  }
  return matched !== 0;
}
