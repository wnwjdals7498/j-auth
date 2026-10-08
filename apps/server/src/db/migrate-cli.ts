import { Pool } from 'pg';
import { loadDatabaseConfig } from '../config.js';
import { migrate } from './migrate.js';

const pool = new Pool(loadDatabaseConfig());
try {
  await migrate(pool);
  process.stdout.write('j-auth database migrations applied.\n');
} catch {
  process.stderr.write(
    'j-auth database migration failed. Check database access and migration integrity.\n',
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
