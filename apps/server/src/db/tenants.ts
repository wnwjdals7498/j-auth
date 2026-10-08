import {
  assertCustomerTenantId,
  customerRealmName,
  SERVICE_CATALOG,
} from '@j-auth/contracts';
import type { Pool } from 'pg';
import { ApiError } from '../errors.js';

export interface TenantClientMapping {
  readonly clientId: string;
  readonly keycloakId: string;
  readonly roles: readonly { name: string; keycloakId: string }[];
}

export interface ActiveTenant {
  readonly tenantId: string;
  readonly realmName: string;
  readonly keyHashes: readonly string[];
}

export class TenantStore {
  constructor(private readonly pool: Pool) {}

  async withLock<T>(tenantId: string, operation: () => Promise<T>): Promise<T> {
    assertCustomerTenantId(tenantId);
    const client = await this.pool.connect();
    let locked = false;
    let discard: Error | undefined;
    try {
      const result = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended('j-auth-tenant:' || $1, 0)) AS locked",
        [tenantId],
      );
      locked = result.rows[0]?.locked === true;
      if (!locked)
        throw new ApiError(
          409,
          'conflict',
          'A tenant operation is in progress. Retry later.',
        );
      return await operation();
    } finally {
      if (locked) {
        try {
          await client.query(
            "SELECT pg_advisory_unlock(hashtextextended('j-auth-tenant:' || $1, 0))",
            [tenantId],
          );
        } catch {
          discard = new Error('Tenant lock connection lost.');
        }
      }
      client.release(discard);
    }
  }

  async beginCreation(
    tenantId: string,
    username: string,
  ): Promise<string | undefined> {
    await this.reserve(tenantId);
    const result = await this.pool.query<{ provisioning_id: string }>(
      `UPDATE tenants SET status = 'creating', bootstrap_username = $2, updated_at = now()
       WHERE tenant_id = $1 AND status <> 'active'
         AND (bootstrap_username IS NULL OR bootstrap_username = $2)
       RETURNING provisioning_id`,
      [tenantId, username],
    );
    return result.rows[0]?.provisioning_id;
  }

  async canRotateKey(tenantId: string): Promise<boolean> {
    const result = await this.pool.query<{ allowed: boolean }>(
      `SELECT previous_key_expires_at IS NULL OR previous_key_expires_at <= now() AS allowed
       FROM tenants WHERE tenant_id = $1 AND status = 'active'`,
      [tenantId],
    );
    return result.rows[0]?.allowed === true;
  }

  async syncClients(
    tenantId: string,
    clients: readonly TenantClientMapping[],
  ): Promise<void> {
    assertCustomerTenantId(tenantId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const active = await client.query(
        "SELECT 1 FROM tenants WHERE tenant_id = $1 AND status = 'active' FOR UPDATE",
        [tenantId],
      );
      if (!active.rowCount) throw new Error('Tenant is not active.');
      await client.query('DELETE FROM tenant_clients WHERE tenant_id = $1', [
        tenantId,
      ]);
      for (const entry of clients) {
        await client.query(
          'INSERT INTO tenant_clients (tenant_id, client_id, keycloak_id) VALUES ($1, $2, $3)',
          [tenantId, entry.clientId, entry.keycloakId],
        );
        for (const role of entry.roles)
          await client.query(
            'INSERT INTO tenant_client_roles (tenant_id, client_id, role_name, keycloak_id) VALUES ($1, $2, $3, $4)',
            [tenantId, entry.clientId, role.name, role.keycloakId],
          );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async findActive(tenantId: string): Promise<ActiveTenant | undefined> {
    assertCustomerTenantId(tenantId);
    const result = await this.pool.query<{
      tenant_id: string;
      realm_name: string;
      service_key_hash: string;
      previous_hash: string | null;
    }>(
      `SELECT tenant_id, realm_name, service_key_hash,
       CASE WHEN previous_key_expires_at > now() THEN previous_service_key_hash END AS previous_hash
       FROM tenants WHERE tenant_id = $1 AND status = 'active'`,
      [tenantId],
    );
    const row = result.rows[0];
    return row
      ? {
          tenantId: row.tenant_id,
          realmName: row.realm_name,
          keyHashes: [
            row.service_key_hash,
            ...(row.previous_hash ? [row.previous_hash] : []),
          ],
        }
      : undefined;
  }

  async reserve(tenantId: string): Promise<boolean> {
    assertCustomerTenantId(tenantId);
    const result = await this.pool.query(
      `INSERT INTO tenants (tenant_id, realm_name)
      VALUES ($1, $2) ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId, customerRealmName(tenantId)],
    );
    return result.rowCount === 1;
  }

  async markFailed(tenantId: string): Promise<void> {
    assertCustomerTenantId(tenantId);
    await this.pool.query(
      "UPDATE tenants SET status = 'failed', updated_at = now() WHERE tenant_id = $1 AND status <> 'active'",
      [tenantId],
    );
  }

  async activate(
    tenantId: string,
    hash: string,
    clients: readonly TenantClientMapping[],
  ): Promise<void> {
    assertCustomerTenantId(tenantId);
    if (!/^[a-f0-9]{64}$/.test(hash))
      throw new TypeError('Expected a service key hash.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Do not overwrite an active tenant or replay its bootstrap secrets.
      const locked = await client.query<{ status: string }>(
        'SELECT status FROM tenants WHERE tenant_id = $1 FOR UPDATE',
        [tenantId],
      );
      if (!locked.rows[0] || locked.rows[0].status === 'active')
        throw new Error('Tenant cannot be activated.');
      await client.query('DELETE FROM tenant_clients WHERE tenant_id = $1', [
        tenantId,
      ]);
      for (const entry of clients) {
        await client.query(
          'INSERT INTO tenant_clients (tenant_id, client_id, keycloak_id) VALUES ($1, $2, $3)',
          [tenantId, entry.clientId, entry.keycloakId],
        );
        for (const role of entry.roles) {
          await client.query(
            'INSERT INTO tenant_client_roles (tenant_id, client_id, role_name, keycloak_id) VALUES ($1, $2, $3, $4)',
            [tenantId, entry.clientId, role.name, role.keycloakId],
          );
        }
      }
      await client.query(
        "UPDATE tenants SET status = 'active', service_key_hash = $2, updated_at = now() WHERE tenant_id = $1",
        [tenantId, hash],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async clientId(
    tenantId: string,
    clientId: string,
  ): Promise<string | undefined> {
    assertCustomerTenantId(tenantId);
    const result = await this.pool.query<{ keycloak_id: string }>(
      'SELECT keycloak_id FROM tenant_clients WHERE tenant_id = $1 AND client_id = $2',
      [tenantId, clientId],
    );
    return result.rows[0]?.keycloak_id;
  }

  async serviceIds(tenantId: string): Promise<string[]> {
    assertCustomerTenantId(tenantId);
    const result = await this.pool.query<{ client_id: string }>(
      'SELECT client_id FROM tenant_clients WHERE tenant_id = $1 ORDER BY client_id',
      [tenantId],
    );
    return result.rows.map((row) => row.client_id);
  }

  async roleMapping(
    tenantId: string,
    role: string,
  ): Promise<{ clientId: string; roleId: string } | undefined> {
    assertCustomerTenantId(tenantId);
    // Old imports can contain same-named roles on a different client. Only the
    // catalog's role owner is eligible; never choose an arbitrary matching row.
    const service = SERVICE_CATALOG.find(
      (entry) =>
        entry.tenantService &&
        entry.roles.some(
          (definition) => definition.name === role && definition.grantable,
        ),
    );
    if (!service) return undefined;
    const result = await this.pool.query<{
      client_id: string;
      role_id: string;
    }>(
      `SELECT c.keycloak_id AS client_id, r.keycloak_id AS role_id FROM tenant_client_roles r
       JOIN tenant_clients c USING (tenant_id, client_id) WHERE r.tenant_id = $1 AND r.role_name = $2 AND r.client_id = $3`,
      [tenantId, role, service.clientId],
    );
    const row = result.rows[0];
    return row ? { clientId: row.client_id, roleId: row.role_id } : undefined;
  }

  async rotateKey(
    tenantId: string,
    hash: string,
    overlapSeconds: number,
  ): Promise<boolean> {
    assertCustomerTenantId(tenantId);
    if (
      !/^[a-f0-9]{64}$/.test(hash) ||
      !Number.isInteger(overlapSeconds) ||
      overlapSeconds < 0 ||
      overlapSeconds > 3600
    ) {
      throw new TypeError('Invalid key rotation.');
    }
    const result = await this.pool.query(
      `UPDATE tenants SET
      previous_service_key_hash = CASE WHEN $3 > 0 THEN service_key_hash END,
      previous_key_expires_at = CASE WHEN $3 > 0 THEN now() + $3 * interval '1 second' END,
      service_key_hash = $2, updated_at = now() WHERE tenant_id = $1 AND status = 'active'`,
      [tenantId, hash, overlapSeconds],
    );
    return result.rowCount === 1;
  }
}
