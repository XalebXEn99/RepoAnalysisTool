import path from 'node:path';
import fs from 'node:fs';

/**
 * Runtime layout. Everything the app persists lives under <repo>/data so a
 * clone of this repository starts empty and stays fully local.
 * Override with RAT_DATA_DIR for tests.
 */
const ROOT = path.resolve(__dirname, '..', '..');

export const DATA_DIR = process.env.RAT_DATA_DIR ?? path.join(ROOT, 'data');
export const REPOS_DIR = path.join(DATA_DIR, 'repos');
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
export const DB_PATH = process.env.RAT_DB_PATH ?? path.join(DATA_DIR, 'rat.db');
export const CLIENT_DIST = path.join(ROOT, 'dist', 'client');

export const PORT = Number(process.env.RAT_PORT ?? 8787);

/** Rename detection threshold demanded by the brief (docs/test_brief.md §2). */
export const RENAME_THRESHOLD = '50%';

export function ensureDataDirs(): void {
  for (const dir of [DATA_DIR, REPOS_DIR, UPLOADS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
