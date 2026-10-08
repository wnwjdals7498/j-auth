import type { PoolConfig } from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../../', import.meta.url));

export interface ServerConfig {
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly tlsCertificate: string;
  readonly tlsKey: string;
  readonly keycloakPublicUrl: string;
  readonly keycloakAdminUrl: string;
  readonly realmCreatorSecret: string;
  readonly consoleKeyHashes: readonly string[];
  readonly database: PoolConfig;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || value.startsWith('__PLACEHOLDER_'))
    throw new Error(`Set ${name} in the external runtime env file.`);
  return value;
}

function port(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
): number {
  const raw = env[name] ?? String(defaultValue);
  if (!/^\d+$/.test(raw))
    throw new Error(`${name} must be a valid port other than 3001.`);
  const value = Number(raw);
  if (value < 1 || value > 65535 || value === 3001)
    throw new Error(`${name} must be a valid port other than 3001.`);
  return value;
}

function externalFile(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  const relative = path.relative(repository, path.resolve(value));
  if (
    !path.isAbsolute(value) ||
    (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
  ) {
    throw new Error(
      `${name} must point to an absolute file outside the checkout.`,
    );
  }
  return value;
}

function httpsOrigin(value: string, label: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      !url.hostname.endsWith('.jgw.test') ||
      url.port === '3001' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new Error(`${label} must be an HTTPS origin.`);
  }
}

export function loadDatabaseConfig(
  env: NodeJS.ProcessEnv = process.env,
): PoolConfig {
  if (env.JAUTH_DB_NAME && env.JAUTH_DB_NAME !== 'jauth')
    throw new Error('JAUTH_DB_NAME must be jauth.');
  if (env.JAUTH_DB_USER && env.JAUTH_DB_USER !== 'jauth')
    throw new Error('JAUTH_DB_USER must be jauth.');
  return {
    host: env.JAUTH_DB_HOST ?? '127.0.0.1',
    port: port(env, 'JAUTH_DB_PORT', 54230),
    database: 'jauth',
    user: 'jauth',
    password: required(env, 'JAUTH_DB_PASSWORD'),
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 5_000,
    application_name: 'j-auth',
  };
}

export function loadServerConfig(
  env: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const hash = required(env, 'JAUTH_CONSOLE_KEY_HASH');
  if (!/^[a-f0-9]{64}$/.test(hash))
    throw new Error('JAUTH_CONSOLE_KEY_HASH must be a SHA-256 hex digest.');
  const publicUrl = httpsOrigin(
    required(env, 'KC_PUBLIC_URL'),
    'KC_PUBLIC_URL',
  );
  return {
    host: '127.0.0.1',
    port: port(env, 'JAUTH_PORT', 54231),
    tlsCertificate: externalFile(env, 'JAUTH_TLS_CERTIFICATE'),
    tlsKey: externalFile(env, 'JAUTH_TLS_KEY'),
    keycloakPublicUrl: publicUrl,
    keycloakAdminUrl: httpsOrigin(
      env.KC_ADMIN_URL ?? publicUrl,
      'KC_ADMIN_URL',
    ),
    realmCreatorSecret: required(
      env,
      'JGW_MASTER_J_AUTH_REALM_CREATOR_CLIENT_SECRET',
    ),
    consoleKeyHashes: [hash],
    database: loadDatabaseConfig(env),
  };
}
