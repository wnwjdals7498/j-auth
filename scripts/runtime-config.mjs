import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.dirname(repositoryRoot);
const runtimeRootExpected = path.resolve(workspaceRoot, '.suite-runtime', 'j-auth');
const serviceNames = ['j-auth', 'j-groupware', 'j-messenger', 'j-mail', 'j-customer-auth-db', 'j-approval', 'j-talk', 'j-web'];
const requiredRuntimeKeys = [
  'J_AUTH_RUNTIME_DIR',
  'KC_PUBLIC_URL',
  'KC_HTTPS_HOST_PORT',
  'KC_MANAGEMENT_HOST_PORT',
  'PG_HOST_PORT',
  'POSTGRES_SUPERUSER_PASSWORD',
  'KEYCLOAK_DB_PASSWORD',
  'JAUTH_DB_PASSWORD',
  'KC_BOOTSTRAP_ADMIN_USERNAME',
  'KC_BOOTSTRAP_ADMIN_PASSWORD',
];
const secretKeys = ['POSTGRES_SUPERUSER_PASSWORD', 'KEYCLOAK_DB_PASSWORD', 'JAUTH_DB_PASSWORD', 'KC_BOOTSTRAP_ADMIN_PASSWORD'];

function resolveYamlParser() {
  const packageLocations = [
    path.join(repositoryRoot, 'package.json'),
    path.join(workspaceRoot, 'j-groupware', 'tools', 'registry', 'package.json'),
  ];
  for (const packageLocation of packageLocations) {
    try {
      const requireFrom = createRequire(packageLocation);
      const metadata = requireFrom('js-yaml/package.json');
      if (metadata.version !== '5.4.1') continue;
      const parser = requireFrom('js-yaml');
      if (typeof parser.load === 'function') return parser;
    } catch {
      // Probe only already-installed workspace parsers. Never download a dependency.
    }
  }
  throw new Error('The existing local js-yaml 5.4.1 parser is required; install nothing automatically.');
}

const yamlParser = resolveYamlParser();

function canonical(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isWithin(parent, candidate) {
  const relative = path.relative(canonical(parent), canonical(candidate));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function fail(message) {
  throw new Error(message);
}

export function parseEnvText(contents) {
  const values = {};
  for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) fail('Invalid environment file syntax at line ' + String(index + 1) + '.');
    const key = match[1];
    if (Object.prototype.hasOwnProperty.call(values, key)) fail('Duplicate environment key: ' + key + '.');
    let value = match[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function validatePublicUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('KC_PUBLIC_URL must be a valid HTTPS URL.');
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !hostname.endsWith('.jgw.test') || hostname.includes('*') || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    fail('KC_PUBLIC_URL must be a fixed HTTPS host under .jgw.test without credentials or a path.');
  }
  if (url.port && Number(url.port) === 3001) fail('KC_PUBLIC_URL cannot use reserved port 3001.');
  return hostname;
}

function validatePort(value, key) {
  if (!/^\d+$/.test(String(value))) fail(key + ' must be an integer port.');
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(key + ' must be a valid TCP port.');
  if (port === 3001) fail(key + ' cannot use reserved port 3001.');
  return port;
}

async function assertPathHasNoSymlink(target, label, finalType) {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  let current = root;
  const components = path.relative(root, resolved).split(path.sep).filter(Boolean);
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    let entry;
    try {
      entry = await lstat(current);
    } catch {
      fail(label + ' path does not exist or cannot be inspected.');
    }
    if (entry.isSymbolicLink()) fail(label + ' path contains a symlink or junction.');
    if (index < components.length - 1 && !entry.isDirectory()) fail(label + ' path has a non-directory parent component.');
    if (index === components.length - 1 && finalType === 'directory' && !entry.isDirectory()) fail(label + ' must be a directory.');
    if (index === components.length - 1 && finalType === 'file' && !entry.isFile()) fail(label + ' must be a regular file.');
  }
  return resolved;
}

export function validateComposeText(composeText, initText) {
  let compose;
  try {
    compose = yamlParser.load(composeText);
  } catch {
    fail('Compose YAML is malformed or has duplicate keys.');
  }
  if (!compose || typeof compose !== 'object' || !compose.services || typeof compose.services !== 'object') {
    fail('Compose YAML must define services.');
  }
  const serviceNames = Object.keys(compose.services).sort();
  if (serviceNames.length !== 2 || serviceNames[0] !== 'keycloak' || serviceNames[1] !== 'postgres') {
    fail('Compose must define only the Keycloak and PostgreSQL I1 services.');
  }

  const postgres = compose.services.postgres;
  const keycloak = compose.services.keycloak;
  if (postgres.network_mode === 'host' || keycloak.network_mode === 'host') fail('Compose services cannot use host networking.');
  const pgEnvironment = postgres.environment || {};
  const kcEnvironment = keycloak.environment || {};
  const valueIs = (actual, expected) => String(actual) === expected;
  const startsWithInterpolation = (actual, key) => typeof actual === 'string' && actual.startsWith('${' + key + ':?');
  if (postgres.image !== 'postgres:18.6-bookworm' || keycloak.image !== 'quay.io/keycloak/keycloak:26.8.0') {
    fail('Compose images must use the fixed PostgreSQL 18.6 and Keycloak 26.8.0 tags.');
  }
  if (!valueIs(pgEnvironment.POSTGRES_DB, 'postgres') || !valueIs(pgEnvironment.POSTGRES_USER, 'postgres') || !startsWithInterpolation(pgEnvironment.POSTGRES_PASSWORD, 'POSTGRES_SUPERUSER_PASSWORD')) {
    fail('PostgreSQL must use the private bootstrap database and an external superuser password.');
  }
  if (!valueIs(pgEnvironment.PGDATA, '/var/lib/postgresql/18/docker') || !valueIs(pgEnvironment.POSTGRES_INITDB_ARGS, '--auth-host=scram-sha-256')) {
    fail('PostgreSQL 18 PGDATA and host authentication settings are required.');
  }
  if (!startsWithInterpolation(pgEnvironment.KEYCLOAK_DB_PASSWORD, 'KEYCLOAK_DB_PASSWORD') || !startsWithInterpolation(pgEnvironment.JAUTH_DB_PASSWORD, 'JAUTH_DB_PASSWORD')) {
    fail('Dedicated database account passwords must come from the external runtime env file.');
  }
  if (!valueIs(kcEnvironment.KC_DB, 'postgres')
    || !valueIs(kcEnvironment.KC_DB_URL_HOST, 'postgres')
    || !valueIs(kcEnvironment.KC_DB_URL_PORT, '5432')
    || !valueIs(kcEnvironment.KC_DB_URL_DATABASE, 'keycloak')
    || !valueIs(kcEnvironment.KC_DB_USERNAME, 'keycloak')
    || Object.hasOwn(kcEnvironment, 'KC_DB_URL')) {
    fail('Keycloak must connect to the internal keycloak database with its dedicated account.');
  }
  if (!startsWithInterpolation(kcEnvironment.KC_DB_PASSWORD, 'KEYCLOAK_DB_PASSWORD')) fail('Keycloak database password must come from the external runtime env file.');
  if (!startsWithInterpolation(kcEnvironment.KC_HOSTNAME, 'KC_PUBLIC_URL')
    || !valueIs(kcEnvironment.KC_HOSTNAME_STRICT, 'true')
    || !valueIs(kcEnvironment.KC_PROXY_HEADERS, 'xforwarded')
    || !valueIs(kcEnvironment.KC_HTTP_ENABLED, 'false')) {
    fail('Keycloak must use the fixed HTTPS hostname and strict proxy configuration.');
  }
  if (!valueIs(kcEnvironment.KC_HTTPS_PORT, '8443')
    || !valueIs(kcEnvironment.KC_HTTPS_CERTIFICATE_FILE, '/opt/keycloak/conf/tls/server.crt')
    || !valueIs(kcEnvironment.KC_HTTPS_CERTIFICATE_KEY_FILE, '/opt/keycloak/conf/tls/server.key')
    || !valueIs(kcEnvironment.KC_HTTP_MANAGEMENT_PORT, '9000')
    || !valueIs(kcEnvironment.KC_HTTP_MANAGEMENT_SCHEME, 'inherited')
    || !valueIs(kcEnvironment.KC_HEALTH_ENABLED, 'true')) {
    fail('Keycloak HTTPS and management listener settings are required.');
  }
  if (!Array.isArray(keycloak.command) || keycloak.command.length !== 1 || keycloak.command[0] !== 'start') {
    fail('Keycloak must use the production start command.');
  }
  if (keycloak.depends_on?.postgres?.condition !== 'service_healthy') fail('Keycloak must wait for PostgreSQL readiness.');
  if (!startsWithInterpolation(kcEnvironment.KC_BOOTSTRAP_ADMIN_USERNAME, 'KC_BOOTSTRAP_ADMIN_USERNAME')
    || !startsWithInterpolation(kcEnvironment.KC_BOOTSTRAP_ADMIN_PASSWORD, 'KC_BOOTSTRAP_ADMIN_PASSWORD')) {
    fail('Development bootstrap credentials must come from the external runtime env file.');
  }

  const mappings = [
    { service: postgres, target: 5432, variable: 'PG_HOST_PORT', defaultPort: 54230 },
    { service: keycloak, target: 8443, variable: 'KC_HTTPS_HOST_PORT', defaultPort: 8443 },
    { service: keycloak, target: 9000, variable: 'KC_MANAGEMENT_HOST_PORT', defaultPort: 9000 },
  ];
  const allMappings = [];
  for (const mapping of mappings) {
    const ports = mapping.service.ports;
    if (!Array.isArray(ports)) fail('Each local service must declare structured port mappings.');
    const matches = ports.filter((entry) => entry && typeof entry === 'object' && Number(entry.target) === mapping.target);
    if (matches.length !== 1) fail('A required container port mapping is missing or duplicated.');
    const entry = matches[0];
    if (entry.host_ip !== '127.0.0.1') fail('Every published host port must bind to 127.0.0.1.');
    if (entry.protocol !== undefined && entry.protocol !== 'tcp') fail('Only TCP loopback port mappings are supported.');
    let publishedPort;
    if (typeof entry.published === 'number') {
      publishedPort = entry.published;
    } else {
      const match = /^\$\{([A-Z][A-Z0-9_]*)(?::-(\d+))?\}$/.exec(String(entry.published));
      if (!match || match[1] !== mapping.variable || !match[2]) fail('Host ports must use their supported environment variable and default.');
      publishedPort = Number(match[2]);
    }
    if (publishedPort === 3001) fail('Compose must not publish reserved port 3001.');
    if (!Number.isInteger(publishedPort) || publishedPort < 1 || publishedPort > 65535) fail('Compose host port defaults must be valid TCP ports.');
    if (publishedPort !== mapping.defaultPort) fail('Compose host port defaults must match the documented non-standard ports.');
    allMappings.push(entry);
  }
  if (postgres.ports.length !== 1 || keycloak.ports.length !== 2 || allMappings.length !== 3) {
    fail('Compose must publish only the HTTPS, management, and PostgreSQL ports.');
  }

  const postgresVolumes = Array.isArray(postgres.volumes) ? postgres.volumes : [];
  const keycloakVolumes = Array.isArray(keycloak.volumes) ? keycloak.volumes : [];
  if (!postgresVolumes.some((volume) => volume && typeof volume === 'object'
      && volume.target === '/var/lib/postgresql'
      && typeof volume.source === 'string'
      && volume.source.startsWith('${J_AUTH_RUNTIME_DIR:?')
      && volume.source.endsWith('/postgres'))) {
    fail('PostgreSQL data must be mounted under the external runtime directory at its PostgreSQL 18 volume root.');
  }
  if (!keycloakVolumes.some((volume) => volume && typeof volume === 'object'
      && volume.target === '/opt/keycloak/conf/tls'
      && volume.read_only === true
      && typeof volume.source === 'string'
      && volume.source.startsWith('${J_AUTH_RUNTIME_DIR:?')
      && volume.source.endsWith('/tls'))) {
    fail('Keycloak TLS files must be mounted read-only from the external runtime directory.');
  }
  const databaseInit = postgresVolumes.find((volume) => volume && typeof volume === 'object'
    && volume.target === '/docker-entrypoint-initdb.d/010-create-control-plane-databases.sh');
  if (!databaseInit || databaseInit.read_only !== true) fail('The database role boundary initializer must be mounted read-only.');

  for (const required of [
    'CREATE ROLE keycloak LOGIN PASSWORD',
    'CREATE ROLE jauth LOGIN PASSWORD',
    'CREATE DATABASE keycloak OWNER keycloak',
    'CREATE DATABASE jauth OWNER jauth',
    'REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC',
    'FROM keycloak',
    'FROM jauth',
    '\\getenv keycloak_password KEYCLOAK_DB_PASSWORD',
    '\\getenv jauth_password JAUTH_DB_PASSWORD',
  ]) {
    if (!initText.includes(required)) fail('PostgreSQL initialization is missing a database boundary setting.');
  }
  if (/set\s+-x|echo\s+.*(?:PASSWORD|SECRET)/i.test(initText)) fail('PostgreSQL initialization must not print secret values.');
}

export async function validateTemplateFiles({ root = repositoryRoot } = {}) {
  const templatePath = path.join(root, 'deploy', '.env.example');
  const composePath = path.join(root, 'deploy', 'compose.yaml');
  const initPath = path.join(root, 'deploy', 'postgres', 'init-control-plane-databases.sh');
  let templateText;
  let composeText;
  let initText;
  try {
    [templateText, composeText, initText] = await Promise.all([
      readFile(templatePath, 'utf8'),
      readFile(composePath, 'utf8'),
      readFile(initPath, 'utf8'),
    ]);
  } catch {
    fail('Runtime template, Compose, or PostgreSQL initialization source is missing.');
  }
  const values = parseEnvText(templateText);
  for (const key of requiredRuntimeKeys) {
    if (!Object.prototype.hasOwnProperty.call(values, key) || !values[key]) fail('Runtime template is missing required key ' + key + '.');
  }
  for (const key of secretKeys) {
    if (!/^__[A-Z0-9_]+__$/.test(values[key])) fail('Runtime template must use a placeholder for ' + key + '.');
  }
  if (!/^__[A-Z0-9_]+__$/.test(values.KC_BOOTSTRAP_ADMIN_USERNAME)) fail('Runtime template must use a placeholder for KC_BOOTSTRAP_ADMIN_USERNAME.');
  if (!/^__[A-Z0-9_]+__/.test(values.J_AUTH_RUNTIME_DIR)) fail('Runtime template must not contain a real runtime path.');
  validatePublicUrl(values.KC_PUBLIC_URL);
  validatePort(values.KC_HTTPS_HOST_PORT, 'KC_HTTPS_HOST_PORT');
  validatePort(values.KC_MANAGEMENT_HOST_PORT, 'KC_MANAGEMENT_HOST_PORT');
  validatePort(values.PG_HOST_PORT, 'PG_HOST_PORT');
  validateComposeText(composeText, initText);
  return { values, composeText, initText };
}

export async function validateRuntimeValues(values, { root = repositoryRoot, runtimeDirectory, envFilePath } = {}) {
  for (const key of requiredRuntimeKeys) {
    if (typeof values[key] !== 'string' || !values[key].trim()) fail('Runtime configuration is missing required key ' + key + '.');
    if (/^__.*__$/.test(values[key].trim())) fail('Runtime configuration still contains a placeholder for ' + key + '.');
  }
  const allowedRuntimeKeys = new Set(requiredRuntimeKeys);
  for (const key of Object.keys(values)) {
    if (!allowedRuntimeKeys.has(key)) fail('I1 Compose runtime env contains an unsupported key; keep I3 j-auth application credentials in their separate env scope.');
  }
  const hostname = validatePublicUrl(values.KC_PUBLIC_URL);
  const httpsPort = validatePort(values.KC_HTTPS_HOST_PORT, 'KC_HTTPS_HOST_PORT');
  const managementPort = validatePort(values.KC_MANAGEMENT_HOST_PORT, 'KC_MANAGEMENT_HOST_PORT');
  const postgresPort = validatePort(values.PG_HOST_PORT, 'PG_HOST_PORT');
  if (new Set([httpsPort, managementPort, postgresPort]).size !== 3) fail('Published host ports must be unique.');
  const secretValues = secretKeys.map((key) => values[key].trim());
  if (new Set(secretValues).size !== secretValues.length) fail('Database and bootstrap passwords must be distinct.');
  for (const key of secretKeys) if (values[key].trim().length < 16) fail(key + ' must contain at least 16 characters.');

  const actualRuntimeDirectory = path.resolve(values.J_AUTH_RUNTIME_DIR.trim());
  if (!path.isAbsolute(values.J_AUTH_RUNTIME_DIR.trim())) fail('J_AUTH_RUNTIME_DIR must be an absolute path.');
  const expectedRuntimeDirectory = path.resolve(path.dirname(root), '.suite-runtime', 'j-auth');
  if (!isWithin(path.dirname(root), actualRuntimeDirectory) || isWithin(root, actualRuntimeDirectory)) {
    fail('J_AUTH_RUNTIME_DIR must be outside every service checkout under github/.suite-runtime/j-auth.');
  }
  if (canonical(actualRuntimeDirectory) !== canonical(expectedRuntimeDirectory)) {
    fail('J_AUTH_RUNTIME_DIR must resolve to the shared github/.suite-runtime/j-auth location.');
  }
  if (runtimeDirectory && canonical(actualRuntimeDirectory) !== canonical(runtimeDirectory)) fail('Runtime directory does not match the expected test fixture root.');
  await assertPathHasNoSymlink(actualRuntimeDirectory, 'J_AUTH_RUNTIME_DIR', 'directory');

  const resolvedEnvPath = envFilePath ? path.resolve(envFilePath) : undefined;
  if (resolvedEnvPath) {
    if (isWithin(root, resolvedEnvPath)) fail('Runtime environment files must remain outside the repository checkout.');
    if (!isWithin(actualRuntimeDirectory, resolvedEnvPath)) fail('Runtime environment file must be stored inside J_AUTH_RUNTIME_DIR.');
    await assertPathHasNoSymlink(resolvedEnvPath, 'Runtime environment file', 'file');
  }

  const tlsDirectory = path.join(actualRuntimeDirectory, 'tls');
  await assertPathHasNoSymlink(tlsDirectory, 'TLS directory', 'directory');
  const certificatePath = await assertPathHasNoSymlink(path.join(tlsDirectory, 'server.crt'), 'TLS certificate', 'file');
  const privateKeyPath = await assertPathHasNoSymlink(path.join(tlsDirectory, 'server.key'), 'TLS private key', 'file');
  let certificate;
  let privateKey;
  try {
    certificate = new X509Certificate(await readFile(certificatePath));
    privateKey = createPrivateKey(await readFile(privateKeyPath));
  } catch {
    fail('TLS certificate and private key must be valid PEM files.');
  }
  const certificatePublicKey = certificate.publicKey.export({ type: 'spki', format: 'der' });
  const privatePublicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  if (!certificatePublicKey.equals(privatePublicKey)) fail('TLS certificate and private key do not match.');
  const san = certificate.subjectAltName || '';
  if (!san.split(/,\s*/).includes('DNS:' + hostname)) fail('TLS certificate SAN must include the KC_PUBLIC_URL hostname.');
  const notBefore = Date.parse(certificate.validFrom);
  const notAfter = Date.parse(certificate.validTo);
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter) || Date.now() < notBefore || Date.now() > notAfter) {
    fail('TLS certificate is not currently valid.');
  }

  return { runtimeDirectory: actualRuntimeDirectory, publicHostname: hostname };
}

export async function validateRuntimeFile(envFilePath, { root = repositoryRoot } = {}) {
  const resolvedPath = path.resolve(envFilePath);
  if (isWithin(root, resolvedPath)) fail('Runtime environment files must remain outside the repository checkout.');
  await assertPathHasNoSymlink(resolvedPath, 'Runtime environment file', 'file');
  let contents;
  try {
    contents = await readFile(resolvedPath, 'utf8');
  } catch {
    fail('Runtime environment file is missing or unreadable.');
  }
  const values = parseEnvText(contents);
  return await validateRuntimeValues(values, { root, envFilePath: resolvedPath });
}

function parseArgs(argv) {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--template')) return { template: true };
  if (argv.length === 2 && argv[0] === '--env-file') return { envFile: argv[1] };
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  fail('Usage: node scripts/runtime-config.mjs [--template | --env-file <external-runtime-compose.env>].');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: node scripts/runtime-config.mjs [--template | --env-file <external-runtime-compose.env>]\n');
    return;
  }
  if (options.template) {
    await validateTemplateFiles();
    process.stdout.write('Runtime template and static network/database boundaries are valid.\n');
    return;
  }
  await validateRuntimeFile(options.envFile);
  process.stdout.write('External runtime configuration and TLS files are valid.\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write((error instanceof Error ? error.message : 'Runtime configuration check failed.') + '\n');
    process.exitCode = 1;
  });
}
