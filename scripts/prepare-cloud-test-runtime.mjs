import { mkdir, writeFile, access } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  buildSampleRealms,
  buildSampleBootstrapPlan,
  buildOperatorBootstrapPlan,
} from './realm/templates.mjs';
import * as contracts from '../packages/contracts/dist/index.js';
const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const runtime = path.resolve(repository, '..', '.suite-runtime', 'j-auth');
try {
  await access(runtime + '/compose.env');
  throw new Error('Existing test env; refusing to replace credentials.');
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
await mkdir(runtime + '/tls', { recursive: true, mode: 0o700 });
await mkdir(runtime + '/imports', { recursive: true, mode: 0o700 });
const secret = () => randomBytes(32).toString('base64url');
const compose = {
  J_AUTH_RUNTIME_DIR: runtime,
  KC_PUBLIC_URL: 'https://auth.jgw.test:58443',
  KC_HTTPS_HOST_PORT: '58443',
  KC_MANAGEMENT_HOST_PORT: '59000',
  PG_HOST_PORT: '54230',
  POSTGRES_SUPERUSER_PASSWORD: secret(),
  KEYCLOAK_DB_PASSWORD: secret(),
  JAUTH_DB_PASSWORD: secret(),
  KC_BOOTSTRAP_ADMIN_USERNAME: 'cloud-test-admin',
  KC_BOOTSTRAP_ADMIN_PASSWORD: secret(),
};
const imports = {};
for (const realm of buildSampleRealms(contracts)) {
  await writeFile(
    `${runtime}/imports/${realm.realm}-realm.json`,
    JSON.stringify(realm, null, 2),
    { mode: 0o600 },
  );
  const plan =
    realm.realm === 'operator'
      ? buildOperatorBootstrapPlan(contracts)
      : buildSampleBootstrapPlan(realm.realm.slice(7), contracts);
  for (const name of plan.environment.requiredImportKeys)
    imports[name] = secret();
}
const consoleKey = secret();
const integration = {
  ...compose,
  ...imports,
  JAUTH_TEST_RUNTIME: 'isolated-cloud',
  JGW_SAMPLE_A_SERVICE_KEY: secret(),
  JGW_SAMPLE_B_SERVICE_KEY: secret(),
  JGW_SAMPLE_C_SERVICE_KEY: secret(),
  JGW_MASTER_J_AUTH_REALM_CREATOR_CLIENT_SECRET: secret(),
  JAUTH_CONSOLE_SERVICE_KEY: consoleKey,
  JAUTH_CONSOLE_KEY_HASH: createHash('sha256').update(consoleKey).digest('hex'),
  JAUTH_PORT: '54231',
  JAUTH_TLS_CERTIFICATE: runtime + '/tls/server.crt',
  JAUTH_TLS_KEY: runtime + '/tls/server.key',
  NODE_EXTRA_CA_CERTS: runtime + '/tls/server.crt',
  KC_ADMIN_URL: compose.KC_PUBLIC_URL,
};
for (const [file, values] of [
  ['compose.env', compose],
  ['import.env', imports],
  ['integration.env', integration],
])
  await writeFile(
    `${runtime}/${file}`,
    Object.entries(values)
      .map(([k, v]) => `${k}=${v}\n`)
      .join(''),
    { mode: 0o600 },
  );
const result = spawnSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:3072',
    '-sha256',
    '-nodes',
    '-keyout',
    runtime + '/tls/server.key',
    '-out',
    runtime + '/tls/server.crt',
    '-days',
    '30',
    '-subj',
    '/CN=auth.jgw.test',
    '-addext',
    'subjectAltName=DNS:auth.jgw.test,DNS:jauth.jgw.test,DNS:localhost,IP:127.0.0.1',
  ],
  { stdio: 'ignore' },
);
if (result.status !== 0) throw new Error('TLS certificate generation failed');
await writeFile(
  `${runtime}/compose.integration.yaml`,
  `services:\n  keycloak:\n    command: ["start", "--import-realm"]\n    env_file: ${runtime}/import.env\n    volumes:\n      - type: bind\n        source: ${runtime}/imports\n        target: /opt/keycloak/data/import\n        read_only: true\n`,
  { mode: 0o600 },
);
console.log(
  'Created isolated cloud test env and HTTPS certificates outside checkouts.',
);
