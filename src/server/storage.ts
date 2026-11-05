import fs from 'node:fs/promises';
import path from 'node:path';
import { REPOS_DIR, UPLOADS_DIR } from './config';

export async function removeRepositoryFiles(id: number): Promise<void> {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('invalid repository storage id');
  await fs.rm(path.join(REPOS_DIR, String(id)), { recursive: true, force: true });
  await fs.rm(path.join(UPLOADS_DIR, `repo-${id}.zip`), { force: true });
}
