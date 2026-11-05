import './env';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function positiveSetting(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export const DATA_DIR = process.env.RAT_DATA_DIR ?? path.join(ROOT, 'data');
export const REPOS_DIR = path.join(DATA_DIR, 'repos');
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
export const CLIENT_DIST = path.join(ROOT, 'dist', 'client');

export const HOST = process.env.RAT_HOST ?? '0.0.0.0';
export const PORT = positiveSetting(process.env.PORT ? 'PORT' : 'RAT_PORT', 8787);
export const APP_ORIGIN = process.env.RAT_APP_ORIGIN ?? 'http://localhost:5173';
if (new URL(APP_ORIGIN).origin !== APP_ORIGIN
  || (process.env.NODE_ENV === 'production' && !APP_ORIGIN.startsWith('https://'))) {
  throw new Error('RAT_APP_ORIGIN must be an origin (HTTPS is required in production)');
}
export const MAX_UPLOAD_BYTES = positiveSetting('RAT_MAX_UPLOAD_MB', 100) * 1024 * 1024;
export const MAX_EXTRACT_BYTES = positiveSetting('RAT_MAX_EXTRACT_MB', 1024) * 1024 * 1024;
export const GIT_TIMEOUT_MS = positiveSetting('RAT_GIT_TIMEOUT_SECONDS', 600) * 1000;
export const MAX_REPOSITORIES = positiveSetting('RAT_MAX_REPOSITORIES', 10);

/** Rename detection threshold demanded by the brief (docs/test_brief.md §2). */
export const RENAME_THRESHOLD = '50%';

export function ensureDataDirs(): void {
  for (const dir of [DATA_DIR, REPOS_DIR, UPLOADS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
