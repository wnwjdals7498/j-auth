import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes, sign, createPublicKey } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  parseEnvText,
  validateComposeText,
  validateRuntimeFile,
  validateRuntimeValues,
  validateTemplateFiles,
} from '../../scripts/runtime-config.mjs';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, '..', '..');
const runtimeConfigScript = path.join(repositoryRoot, 'scripts', 'runtime-config.mjs');
const serviceNames = ['j-auth', 'j-groupware', 'j-messenger', 'j-mail', 'j-customer-auth-db', 'j-approval', 'j-talk', 'j-web'];

function der(tag, body) {
  let length;
  if (body.length < 128) {
    length = Buffer.from([body.length]);
  } else {
    const bytes = [];
    let remaining = body.length;
    while (remaining > 0) {
      bytes.unshift(remaining & 0xff);
      remaining = Math.floor(remaining / 256);
    }
    length = Buffer.from([0x80 | bytes.length, ...bytes]);
  }
  return Buffer.concat([Buffer.from([tag]), length, body]);
}

function derSequence(...items) {
  return der(0x30, Buffer.concat(items));
}

function derOid(oid) {
  const arcs = oid.split('.').map(Number);
  const encoded = [40 * arcs[0] + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const pieces = [arc & 0x7f];
    let remaining = Math.floor(arc / 128);
    while (remaining > 0) {
      pieces.unshift(0x80 | (remaining & 0x7f));
      remaining = Math.floor(remaining / 128);
    }
    encoded.push(...pieces);
  }
  return der(0x06, Buffer.from(encoded));
}

function derInteger(value) {
  let hex = BigInt(value).toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let bytes = Buffer.from(hex, 'hex');
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return der(0x02, bytes);
}

function derName(commonName) {
  const commonNameAttribute = derSequence(derOid('2.5.4.3'), der(0x0c, Buffer.from(commonName, 'utf8')));
  return derSequence(der(0x31, commonNameAttribute));
}

function formatUtcTime(date) {
  const two = (value) => String(value).padStart(2, '0');
  return two(date.getUTCFullYear() % 100)
    + two(date.getUTCMonth() + 1)
    + two(date.getUTCDate())
    + two(date.getUTCHours())
    + two(date.getUTCMinutes())
    + two(date.getUTCSeconds())
    + 'Z';
}

function pem(label, data) {
  const base64 = data.toString('base64');
  const rows = base64.match(/.{1,64}/g) || [];
  return '-----BEGIN ' + label + '-----\n' + rows.join('\n') + '\n-----END ' + label + '-----\n';
}

function createTestCertificate(commonName) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'der' },
  });
  const name = derName(commonName);
  const now = new Date();
  const start = new Date(now.getTime() - 60_000);
  const end = new Date(now.getTime() + 86_400_000);
  const signatureAlgorithm = derSequence(derOid('1.2.840.113549.1.1.11'), der(0x05, Buffer.alloc(0)));
  const validity = derSequence(der(0x17, Buffer.from(formatUtcTime(start))), der(0x17, Buffer.from(formatUtcTime(end))));
  const sanValue = derSequence(der(0x82, Buffer.from(commonName, 'ascii')));
  const sanExtension = derSequence(derOid('2.5.29.17'), der(0x04, sanValue));
  const extensions = der(0xa3, derSequence(sanExtension));
  const serial = BigInt('0x' + randomBytes(16).toString('hex'));
  const tbs = derSequence(
    der(0xa0, derInteger(2)),
    derInteger(serial),
    signatureAlgorithm,
    name,
    validity,
    name,
    publicKey,
    extensions,
  );
  const signature = sign('sha256', tbs, privateKey);
  const certificate = derSequence(tbs, signatureAlgorithm, der(0x03, Buffer.concat([Buffer.from([0]), signature])));
  return {
    certificatePem: pem('CERTIFICATE', certificate),
    privateKeyPem: privateKey,
    publicKeyDer: createPublicKey(privateKey).export({ type: 'spki', format: 'der' }),
  };
}

function isWithin(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

async function runNode(args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repositoryRoot,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', () => reject(new Error('Could not start the Node runtime checker.')));
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function createRuntimeFixture() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'j-auth-runtime-config-'));
  const fakeRepositoryRoot = path.join(temporaryRoot, 'workspace', 'j-auth');
  const fakeWorkspaceRoot = path.dirname(fakeRepositoryRoot);
  const runtimeDirectory = path.join(fakeWorkspaceRoot, '.suite-runtime', 'j-auth');
  const tlsDirectory = path.join(runtimeDirectory, 'tls');
  await mkdir(path.join(fakeWorkspaceRoot, 'j-groupware'), { recursive: true });
  await mkdir(fakeRepositoryRoot, { recursive: true });
  await mkdir(tlsDirectory, { recursive: true });
  const tls = createTestCertificate('auth.jgw.test');
  const certificatePath = path.join(tlsDirectory, 'server.crt');
  const privateKeyPath = path.join(tlsDirectory, 'server.key');
  await writeFile(certificatePath, tls.certificatePem, { flag: 'wx' });
  await writeFile(privateKeyPath, tls.privateKeyPem, { flag: 'wx' });
  const values = {
    J_AUTH_RUNTIME_DIR: runtimeDirectory,
    KC_PUBLIC_URL: 'https://auth.jgw.test',
    KC_HTTPS_HOST_PORT: '8443',
    KC_MANAGEMENT_HOST_PORT: '9000',
    PG_HOST_PORT: '54230',
    POSTGRES_SUPERUSER_PASSWORD: randomBytes(32).toString('hex'),
    KEYCLOAK_DB_PASSWORD: randomBytes(32).toString('hex'),
    JAUTH_DB_PASSWORD: randomBytes(32).toString('hex'),
    KC_BOOTSTRAP_ADMIN_USERNAME: 'bootstrap-test-user',
    KC_BOOTSTRAP_ADMIN_PASSWORD: randomBytes(32).toString('hex'),
  };
  const envFilePath = path.join(runtimeDirectory, 'compose.env');
  const envText = Object.entries(values).map(([key, value]) => key + '=' + value).join('\n') + '\n';
  await writeFile(envFilePath, envText, { flag: 'wx' });
  return { temporaryRoot, fakeRepositoryRoot, runtimeDirectory, envFilePath, envText, values, tls };
}

test('runtime template and configuration checker enforces local database/TLS boundaries', async () => {
  const template = await validateTemplateFiles();
  assert.equal(template.values.KC_PUBLIC_URL, 'https://auth.jgw.test');

  const fixture = await createRuntimeFixture();
  try {
    const validRuntime = await validateRuntimeValues(fixture.values, { root: fixture.fakeRepositoryRoot });
    assert.equal(validRuntime.publicHostname, 'auth.jgw.test');
    assert.equal(path.resolve(validRuntime.runtimeDirectory), path.resolve(fixture.runtimeDirectory));

    const parsedRuntime = await validateRuntimeFile(fixture.envFilePath, { root: fixture.fakeRepositoryRoot });
    assert.equal(path.resolve(parsedRuntime.runtimeDirectory), path.resolve(fixture.runtimeDirectory));
    const envCheck = await runNode([runtimeConfigScript]);
    assert.equal(envCheck.code, 0, 'The checked-in runtime template must pass read-only validation.');
    const invalidEnvCli = await runNode([runtimeConfigScript, '--env-file', fixture.envFilePath]);
    assert.notEqual(invalidEnvCli.code, 0, 'The CLI must reject a runtime env outside the repository runtime root.');
    for (const secret of Object.values(fixture.values)) {
      if (secret.length >= 24) {
        assert.equal(envCheck.stdout.includes(secret), false, 'Runtime checker output must not expose secret values.');
        assert.equal(envCheck.stderr.includes(secret), false, 'Runtime checker errors must not expose secret values.');
        assert.equal(invalidEnvCli.stdout.includes(secret), false, 'Runtime checker stdout must not expose runtime secrets.');
        assert.equal(invalidEnvCli.stderr.includes(secret), false, 'Runtime checker errors must not expose runtime secrets.');
      }
    }

    const invalidPublicUrl = { ...fixture.values, KC_PUBLIC_URL: 'https://example.com' };
    await assert.rejects(validateRuntimeValues(invalidPublicUrl, { root: fixture.fakeRepositoryRoot }), /KC_PUBLIC_URL/);

    const invalidPort = { ...fixture.values, PG_HOST_PORT: '3001' };
    await assert.rejects(validateRuntimeValues(invalidPort, { root: fixture.fakeRepositoryRoot }), /3001/);

    const directDevelopmentUrl = { ...fixture.values, KC_PUBLIC_URL: 'https://auth.jgw.test:8443' };
    await validateRuntimeValues(directDevelopmentUrl, { root: fixture.fakeRepositoryRoot });

    const configurableStandardHostPorts = { ...fixture.values, KC_HTTPS_HOST_PORT: '443', KC_MANAGEMENT_HOST_PORT: '8080', PG_HOST_PORT: '5432' };
    await validateRuntimeValues(configurableStandardHostPorts, { root: fixture.fakeRepositoryRoot });

    const checkoutRuntime = { ...fixture.values, J_AUTH_RUNTIME_DIR: path.join(fixture.fakeRepositoryRoot, 'runtime') };
    await assert.rejects(validateRuntimeValues(checkoutRuntime, { root: fixture.fakeRepositoryRoot }), /outside every service checkout/);

    const duplicateSecrets = { ...fixture.values, JAUTH_DB_PASSWORD: fixture.values.KEYCLOAK_DB_PASSWORD };
    await assert.rejects(validateRuntimeValues(duplicateSecrets, { root: fixture.fakeRepositoryRoot }), /must be distinct/);

    const appCredentialInComposeEnv = { ...fixture.values, MASTER_REALM_CREATOR_PASSWORD: randomBytes(32).toString('hex') };
    await assert.rejects(validateRuntimeValues(appCredentialInComposeEnv, { root: fixture.fakeRepositoryRoot }), /I3 j-auth application credentials/);

    const mismatchedTls = { ...fixture.values };
    const secondKey = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'der' },
    });
    await writeFile(path.join(fixture.runtimeDirectory, 'tls', 'server.key'), secondKey.privateKey, { flag: 'w' });
    await assert.rejects(validateRuntimeValues(mismatchedTls, { root: fixture.fakeRepositoryRoot }), /do not match/);
    await writeFile(path.join(fixture.runtimeDirectory, 'tls', 'server.key'), fixture.tls.privateKeyPem, { flag: 'w' });

    const keyPath = path.join(fixture.runtimeDirectory, 'tls', 'server.key');
    const validKey = await readFile(keyPath);
    await unlink(keyPath);
    await assert.rejects(validateRuntimeValues(fixture.values, { root: fixture.fakeRepositoryRoot }), /path does not exist/);
    await writeFile(keyPath, validKey, { flag: 'wx' });

    const junctionWorkspace = path.join(fixture.temporaryRoot, 'junction-workspace');
    const junctionRepo = path.join(junctionWorkspace, 'j-auth');
    const junctionRuntimeParent = path.join(junctionWorkspace, '.suite-runtime');
    const junctionRuntime = path.join(junctionRuntimeParent, 'j-auth');
    await mkdir(junctionRepo, { recursive: true });
    await mkdir(junctionRuntimeParent, { recursive: true });
    let runtimeJunctionCreated = false;
    try {
      await symlink(fixture.runtimeDirectory, junctionRuntime, 'junction');
      runtimeJunctionCreated = true;
    } catch {
      // Some managed Windows hosts disallow temporary junction creation.
    }
    if (runtimeJunctionCreated) {
      const junctionEnv = { ...fixture.values, J_AUTH_RUNTIME_DIR: junctionRuntime };
      await assert.rejects(validateRuntimeValues(junctionEnv, { root: junctionRepo }), /symlink or junction/);
    }

    const compose = await readFile(path.join(repositoryRoot, 'deploy', 'compose.yaml'), 'utf8');
    const initSql = await readFile(path.join(repositoryRoot, 'deploy', 'postgres', 'init-control-plane-databases.sh'), 'utf8');
    assert.throws(() => validateComposeText(compose.replace('host_ip: 127.0.0.1', 'host_ip: 0.0.0.0'), initSql), /127\.0\.0\.1/);
    assert.throws(() => validateComposeText(compose.replace('${PG_HOST_PORT:-54230}', '${PG_HOST_PORT:-3001}'), initSql), /3001/);
    assert.throws(() => validateComposeText(compose.replace('KC_DB_URL_HOST: postgres', 'KC_DB_URL_HOST: database.example.com'), initSql), /internal keycloak database/);
    assert.throws(() => validateComposeText(compose + '\nservices:\n  duplicate: {}\n', initSql), /malformed or has duplicate keys/);

    const duplicateKey = 'KC_PUBLIC_URL=https://auth.jgw.test\nKC_PUBLIC_URL=https://auth.jgw.test\n';
    assert.throws(() => parseEnvText(duplicateKey), /Duplicate environment key/);
  } finally {
    if (isWithin(os.tmpdir(), fixture.temporaryRoot) && path.basename(fixture.temporaryRoot).startsWith('j-auth-runtime-config-')) {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  }
});
