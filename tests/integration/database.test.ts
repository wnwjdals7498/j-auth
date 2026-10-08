import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from '../../apps/server/src/db/migrate.js';
import {
  generateServiceKey,
  matchesServiceKey,
} from '../../apps/server/src/security/service-key.js';
import { databaseRuntime, requiredTestEnv } from './runtime.js';

describe('real PostgreSQL control plane', () => {
  let runtime: Awaited<ReturnType<typeof databaseRuntime>>;
  const created: string[] = [];
  const tenant = () => {
    const id = `db-${randomUUID().slice(0, 12)}`;
    created.push(id);
    return id;
  };
  beforeAll(async () => {
    runtime = await databaseRuntime();
  });
  afterAll(async () => {
    if (runtime) {
      await runtime.pool.query(
        'DELETE FROM tenants WHERE tenant_id = ANY($1::text[])',
        [created],
      );
      await runtime.close();
    }
  });
  it('runs concurrent migrations idempotently and preserves their checksum', async () => {
    await Promise.all([migrate(runtime.pool), migrate(runtime.pool)]);
    const applied = await runtime.pool.query(
      'SELECT name, checksum FROM schema_migrations',
    );
    expect(applied.rows).toHaveLength(1);
    expect(applied.rows[0].checksum).toMatch(/^[a-f0-9]{64}$/);
  });
  it('requires the jauth identity and refuses superuser migrations', async () => {
    const admin = new Pool({
      ...runtime.pool.options,
      user: 'postgres',
      password: requiredTestEnv('POSTGRES_SUPERUSER_PASSWORD'),
    });
    try {
      await expect(migrate(admin)).rejects.toThrow('non-superuser jauth');
    } finally {
      await admin.end();
    }
  });
  it.each([
    ['jauth', 'keycloak', 'JAUTH_DB_PASSWORD'],
    ['keycloak', 'jauth', 'KEYCLOAK_DB_PASSWORD'],
    ['jauth', 'postgres', 'JAUTH_DB_PASSWORD'],
    ['keycloak', 'postgres', 'KEYCLOAK_DB_PASSWORD'],
  ])('denies %s TCP access to %s', async (user, database, secret) => {
    const other = new Pool({
      host: '127.0.0.1',
      port: 54230,
      user,
      database,
      password: requiredTestEnv(secret),
      connectionTimeoutMillis: 3000,
    });
    try {
      await expect(other.query('SELECT 1')).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      await other.end();
    }
  });
  it('keeps pending and failed tenants unavailable and activates only with a digest', async () => {
    const id = tenant();
    const key = generateServiceKey();
    expect(await runtime.tenants.reserve(id)).toBe(true);
    expect(await runtime.tenants.reserve(id)).toBe(false);
    expect(await runtime.tenants.findActive(id)).toBeUndefined();
    await runtime.tenants.markFailed(id);
    expect(await runtime.tenants.findActive(id)).toBeUndefined();
    await runtime.tenants.activate(id, key.hash, [
      {
        clientId: 'j-groupware',
        keycloakId: randomUUID(),
        roles: [{ name: 'board:read', keycloakId: randomUUID() }],
      },
    ]);
    expect((await runtime.tenants.findActive(id))?.keyHashes).toEqual([
      key.hash,
    ]);
    await expect(runtime.tenants.activate(id, key.hash, [])).rejects.toThrow();
    const stored = JSON.stringify(
      (
        await runtime.pool.query('SELECT * FROM tenants WHERE tenant_id = $1', [
          id,
        ])
      ).rows,
    );
    expect(stored).not.toContain(key.serviceKey);
  });
  it('rolls back incomplete client and role mappings atomically', async () => {
    const id = tenant();
    await runtime.tenants.reserve(id);
    const duplicate = randomUUID();
    await expect(
      runtime.tenants.activate(id, generateServiceKey().hash, [
        {
          clientId: 'j-groupware',
          keycloakId: randomUUID(),
          roles: [
            { name: 'board:read', keycloakId: duplicate },
            { name: 'board:write', keycloakId: duplicate },
          ],
        },
      ]),
    ).rejects.toThrow();
    expect(await runtime.tenants.serviceIds(id)).toEqual([]);
    expect(await runtime.tenants.findActive(id)).toBeUndefined();
  });
  it('accepts overlap keys only until their DB expiry and isolates tenants', async () => {
    const id = tenant();
    const first = generateServiceKey();
    const second = generateServiceKey();
    await runtime.tenants.reserve(id);
    await runtime.tenants.activate(id, first.hash, []);
    expect(await runtime.tenants.rotateKey(id, second.hash, 60)).toBe(true);
    const active = await runtime.tenants.findActive(id);
    expect(matchesServiceKey(first.serviceKey, active!.keyHashes)).toBe(true);
    expect(matchesServiceKey(second.serviceKey, active!.keyHashes)).toBe(true);
    expect(
      matchesServiceKey(
        requiredTestEnv('JGW_SAMPLE_B_SERVICE_KEY'),
        active!.keyHashes,
      ),
    ).toBe(false);
    await runtime.pool.query(
      "UPDATE tenants SET previous_key_expires_at = now() - interval '1 second' WHERE tenant_id = $1",
      [id],
    );
    expect(
      matchesServiceKey(
        first.serviceKey,
        (await runtime.tenants.findActive(id))!.keyHashes,
      ),
    ).toBe(false);
    expect(await runtime.tenants.rotateKey(id, first.hash, 0)).toBe(true);
    expect((await runtime.tenants.findActive(id))!.keyHashes).toEqual([
      first.hash,
    ]);
  });
  it('enforces tenant identifiers and active-state/key constraints in the DB', async () => {
    await expect(
      runtime.pool.query(
        "INSERT INTO tenants (tenant_id, realm_name, status) VALUES ('operator', 'tenant-operator', 'active')",
      ),
    ).rejects.toMatchObject({ code: '23514' });
    const id = tenant();
    await expect(
      runtime.pool.query(
        "INSERT INTO tenants (tenant_id, realm_name, status) VALUES ($1, $2, 'active')",
        [id, `tenant-${id}`],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
