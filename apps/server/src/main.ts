import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { CLIENT_IDS } from '@j-auth/contracts';
import { createTokenVerifier } from '@j-auth/token-verifier';
import { createApp } from './app.js';
import { loadServerConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { TenantStore } from './db/tenants.js';
import { KeycloakClient, RealmCredentials } from './keycloak/client.js';

async function main(): Promise<void> {
  const config = loadServerConfig();
  const pool = new Pool(config.database);
  pool.on('error', () => {
    process.stderr.write('j-auth database connection unavailable.\n');
  });
  try {
    await migrate(pool);
    const [cert, key] = await Promise.all([
      readFile(config.tlsCertificate),
      readFile(config.tlsKey),
    ]);
    const creator = new KeycloakClient({
      baseUrl: config.keycloakAdminUrl,
      realm: 'master',
      clientId: CLIENT_IDS.realmCreator,
      secret: async () => config.realmCreatorSecret,
    });
    const app = createApp({
      pool,
      verifier: createTokenVerifier({ publicUrl: config.keycloakPublicUrl }),
      consoleKeyHashes: config.consoleKeyHashes,
      credentials: new RealmCredentials({
        tenants: new TenantStore(pool),
        baseUrl: config.keycloakAdminUrl,
        master: creator,
      }),
      realmCreator: creator,
      https: { cert, key, minVersion: 'TLSv1.2' },
      logger: {
        level: 'info',
        redact: [
          'req.headers.authorization',
          'req.headers.x-jgw-service-key',
          'req.body',
          'res.headers.set-cookie',
        ],
      },
    });
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await app.close();
      await pool.end();
    };
    process.once('SIGTERM', () => {
      void stop();
    });
    process.once('SIGINT', () => {
      void stop();
    });
    await app.listen({ host: config.host, port: config.port });
  } catch {
    await pool.end();
    throw new Error(
      'j-auth startup failed. Check the external runtime configuration and database.',
    );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'j-auth startup failed.'}\n`,
  );
  process.exitCode = 1;
});
