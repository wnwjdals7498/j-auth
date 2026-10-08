import {
  CLIENT_IDS,
  assertCustomerTenantId,
  customerRealmName,
} from '@j-auth/contracts';
import type { TenantStore } from '../db/tenants.js';
import { unavailable } from '../errors.js';

interface AccessToken {
  access_token: string;
  expires_in: number;
}
interface CachedToken {
  token: string;
  expiresAt: number;
}

export function keycloakSegment(value: string): string {
  if (
    !value ||
    value === '.' ||
    value === '..' ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new TypeError('Invalid Keycloak identifier.');
  return encodeURIComponent(value);
}

export class KeycloakClient {
  private token: CachedToken | undefined;
  private pending: Promise<string> | undefined;

  constructor(
    private readonly options: {
      baseUrl: string;
      realm: string;
      clientId: string;
      secret: () => Promise<string>;
      fetch?: typeof globalThis.fetch;
    },
  ) {}

  async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now())
      return this.token.token;
    if (this.pending) return this.pending;
    this.pending = this.issueToken();
    try {
      return await this.pending;
    } finally {
      this.pending = undefined;
    }
  }

  private async issueToken(): Promise<string> {
    try {
      const secret = await this.options.secret();
      const response = await (this.options.fetch ?? fetch)(
        `${this.options.baseUrl}/realms/${keycloakSegment(this.options.realm)}/protocol/openid-connect/token`,
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(5_000),
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: this.options.clientId,
            client_secret: secret,
          }),
        },
      );
      if (!response.ok) throw unavailable();
      const data = (await response.json()) as AccessToken;
      if (
        typeof data.access_token !== 'string' ||
        !Number.isFinite(data.expires_in) ||
        data.expires_in <= 0
      )
        throw unavailable();
      this.token = {
        token: data.access_token,
        expiresAt: Date.now() + Math.max(0, data.expires_in - 10) * 1000,
      };
      return data.access_token;
    } catch {
      throw unavailable();
    }
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    // Callers construct relative Admin API paths; never follow a redirect with credentials.
    if (
      (path !== '/admin/realms' && !path.startsWith('/admin/realms/')) ||
      path.includes('..') ||
      path.includes('://')
    )
      throw new TypeError('Invalid Keycloak API path.');
    try {
      const token = await this.accessToken();
      const response = await (this.options.fetch ?? fetch)(
        `${this.options.baseUrl}${path}`,
        {
          ...init,
          redirect: 'error',
          signal: AbortSignal.timeout(5_000),
          headers: {
            'Content-Type': 'application/json',
            ...init.headers,
            Authorization: `Bearer ${token}`,
          },
        },
      );
      if (response.status === 401) this.token = undefined;
      return response;
    } catch {
      throw unavailable();
    }
  }

  clear(): void {
    this.token = undefined;
  }
}

export class RealmCredentials {
  private readonly entries = new Map<
    string,
    { secret: string; expiresAt: number }
  >();
  private readonly pending = new Map<string, Promise<string>>();
  private readonly clients = new Map<string, KeycloakClient>();

  constructor(
    private readonly options: {
      master: KeycloakClient;
      baseUrl: string;
      tenants: TenantStore;
      fetch?: typeof globalThis.fetch;
    },
  ) {}

  async secret(
    tenantId: string,
    clientId: typeof CLIENT_IDS.memberAdmin | typeof CLIENT_IDS.provisioner,
  ): Promise<string> {
    assertCustomerTenantId(tenantId);
    if (
      clientId !== CLIENT_IDS.memberAdmin &&
      clientId !== CLIENT_IDS.provisioner
    )
      throw new TypeError('Unsupported realm credential.');
    if (!(await this.options.tenants.findActive(tenantId))) throw unavailable();
    const key = `${tenantId}:${clientId}`;
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.secret;
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    const load = this.readSecret(tenantId, clientId);
    this.pending.set(key, load);
    try {
      return await load;
    } finally {
      this.pending.delete(key);
    }
  }

  private async readSecret(
    tenantId: string,
    clientId: string,
  ): Promise<string> {
    const id = await this.options.tenants.clientId(tenantId, clientId);
    if (!id) throw unavailable();
    const realm = customerRealmName(tenantId);
    const response = await this.options.master.request(
      `/admin/realms/${keycloakSegment(realm)}/clients/${keycloakSegment(id)}/client-secret`,
    );
    if (!response.ok) throw unavailable();
    let data;
    try {
      data = (await response.json()) as { value?: unknown };
    } catch {
      throw unavailable();
    }
    if (typeof data.value !== 'string' || data.value.length === 0)
      throw unavailable();
    if (this.entries.size >= 100)
      this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(`${tenantId}:${clientId}`, {
      secret: data.value,
      expiresAt: Date.now() + 60_000,
    });
    return data.value;
  }

  client(tenantId: string, purpose: 'member' | 'provisioner'): KeycloakClient {
    assertCustomerTenantId(tenantId);
    const clientId =
      purpose === 'member' ? CLIENT_IDS.memberAdmin : CLIENT_IDS.provisioner;
    const key = `${tenantId}:${clientId}`;
    let client = this.clients.get(key);
    if (!client) {
      client = new KeycloakClient({
        baseUrl: this.options.baseUrl,
        realm: customerRealmName(tenantId),
        clientId,
        secret: () => this.secret(tenantId, clientId),
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      });
      if (this.clients.size >= 100)
        this.clients.delete(this.clients.keys().next().value!);
      this.clients.set(key, client);
    }
    return client;
  }

  invalidate(tenantId: string): void {
    for (const id of [CLIENT_IDS.memberAdmin, CLIENT_IDS.provisioner]) {
      const key = `${tenantId}:${id}`;
      this.entries.delete(key);
      this.clients.get(key)?.clear();
      this.clients.delete(key);
    }
  }
}
