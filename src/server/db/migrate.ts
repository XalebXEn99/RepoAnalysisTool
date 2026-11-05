import { connectDatabase, closeDb } from './connection';
import { MIGRATIONS } from './schema';

export async function migrate(): Promise<void> {
  // Session-level migration locking must use the direct connection.
  const client = await connectDatabase();
  try {
    await client.query('SELECT pg_advisory_lock(7438201)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    for (const migration of MIGRATIONS) {
      if ((await client.query('SELECT version FROM schema_migrations WHERE version=$1', [migration.version])).rowCount) continue;
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [migration.version]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(7438201)');
    client.release();
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL_UNPOOLED) throw new Error('DATABASE_URL_UNPOOLED is required for migrations');
  process.env.DATABASE_URL = process.env.DATABASE_URL_UNPOOLED;
  try {
    await migrate();
    console.log('[database] migrations applied');
  } finally {
    await closeDb();
  }
}

if (process.argv[1]?.match(/[/\\]migrate\.(ts|mjs)$/)) {
  void main().catch((error: unknown) => {
    console.error('[database] migration failed', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
