import { PGlite } from '@electric-sql/pglite';
import { closeDb, useTestDatabase } from '../../src/server/db/connection';
import { MIGRATIONS } from '../../src/server/db/schema';

export async function setupTestDatabase(): Promise<void> {
  const database = new PGlite();
  await database.exec(MIGRATIONS[0].sql);
  useTestDatabase(database);
}

export async function closeTestDatabase(): Promise<void> {
  await closeDb();
}

export { setupTestDatabase as setupDatabase, closeTestDatabase as cleanupDatabase };
