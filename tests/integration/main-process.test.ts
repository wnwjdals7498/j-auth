import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { integrationRuntime, requiredTestEnv } from './runtime.js';

describe('compiled server lifecycle', () => {
  it('starts over HTTPS, authenticates and shuts down with SIGTERM across restart', async () => {
    const runtime = await integrationRuntime();
    const token = (await runtime.passwordToken('sample-a', 'a-admin'))
      .access_token;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const child = spawn(
          process.execPath,
          [
            `--env-file=${requiredTestEnv('JAUTH_TEST_ENV')}`,
            '--import',
            fileURLToPath(new URL('./resolve-test-hosts.mjs', import.meta.url)),
            'apps/server/dist/main.js',
          ],
          {
            cwd: fileURLToPath(new URL('../../', import.meta.url)),
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: false,
          },
        );
        let logs = '';
        child.stdout.on('data', (chunk: Buffer) => {
          logs += chunk.toString();
        });
        child.stderr.on('data', (chunk: Buffer) => {
          logs += chunk.toString();
        });
        const exit = new Promise<number | null>((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', (code) => resolve(code));
        });
        try {
          let ready = false;
          for (let poll = 0; poll < 60; poll++) {
            if (child.exitCode !== null)
              throw new Error('Compiled j-auth exited before readiness.');
            try {
              ready = (
                await runtime.fetch(
                  'https://jauth.jgw.test:54231/health/ready',
                  { signal: AbortSignal.timeout(500) },
                )
              ).ok;
            } catch {
              /* startup */
            }
            if (ready) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          expect(ready).toBe(true);
          const response = await runtime.fetch(
            'https://jauth.jgw.test:54231/auth/members/grantable-roles',
            {
              headers: {
                Authorization: `Bearer ${token}`,
                'X-JGW-Service-Key': requiredTestEnv(
                  'JGW_SAMPLE_A_SERVICE_KEY',
                ),
              },
            },
          );
          expect(response.status).toBe(200);
          const denied = await runtime.fetch(
            'https://jauth.jgw.test:54231/auth/members',
            { headers: { Authorization: `Bearer ${token}` } },
          );
          expect(denied.status).toBe(401);
          child.kill('SIGTERM');
          expect(await exit).toBe(0);
          expect(logs.includes(token)).toBe(false);
          for (const name of [
            'JAUTH_DB_PASSWORD',
            'JGW_SAMPLE_A_SERVICE_KEY',
            'JGW_MASTER_J_AUTH_REALM_CREATOR_CLIENT_SECRET',
          ]) {
            expect(logs.includes(requiredTestEnv(name))).toBe(false);
          }
        } finally {
          if (child.exitCode === null) {
            child.kill('SIGTERM');
            await exit;
          }
        }
      }
    } finally {
      await runtime.close();
    }
  });
});
