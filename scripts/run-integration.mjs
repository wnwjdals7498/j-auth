import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, realpath } from 'node:fs/promises';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultEnv = resolve(
  repository,
  '..',
  '.suite-runtime',
  'j-auth',
  'integration.env',
);
try {
  const env = await realpath(process.env.JAUTH_TEST_ENV ?? defaultEnv);
  if (env === repository || env.startsWith(repository + '/'))
    throw new Error('Keep test env files outside the checkout.');
  await access(env);
  const child = spawn(
    process.execPath,
    [
      `--env-file=${env}`,
      resolve(repository, 'node_modules/vitest/vitest.mjs'),
      'run',
      '--config',
      'vitest.integration.config.ts',
      ...process.argv.slice(2),
    ],
    {
      cwd: repository,
      env: { ...process.env, JAUTH_TEST_ENV: env },
      shell: false,
      stdio: 'inherit',
    },
  );
  child.once('error', () => {
    process.stderr.write('Could not start the integration runner.\n');
    process.exitCode = 1;
  });
  child.once('close', (code) => {
    process.exitCode = code ?? 1;
  });
} catch {
  process.stderr.write(
    'Integration tests require an existing external isolated test env. Prepare the cloud test runtime first. No integration tests were run.\n',
  );
  process.exitCode = 1;
}
