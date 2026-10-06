import Database from 'better-sqlite3';
import { DB_PATH, ensureDataDirs } from '../config';
import { SCHEMA_SQL } from './schema';

let instance: Database.Database | null = null;

/** Process-wide SQLite handle (WAL mode so reads stay fast during ingest). */
export function db(): Database.Database {
  if (!instance) {
    ensureDataDirs();
    instance = new Database(DB_PATH);
    instance.exec(SCHEMA_SQL);
  }
  return instance;
}

export function closeDb(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}
