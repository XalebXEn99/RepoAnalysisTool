import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { REPOS_DIR, UPLOADS_DIR, MAX_UPLOAD_BYTES, MAX_REPOSITORIES } from '../config';
import { query } from '../db/connection';
import { repoNameFromUrl, repoNameFromZip, validateRemoteUrl } from '../ingest/gitSource';
import { toJob, toSummary } from './mappers';
import { asyncRoute, positiveId, HttpError } from '../http';
import { removeRepositoryFiles } from '../storage';
import { enqueue } from '../jobs/jobManager';
import { wakeWorker } from '../jobs/wake';

export const reposRouter = Router();
reposRouter.get('/', asyncRoute(async (_req, res) => {
  res.json((await query('SELECT * FROM repositories ORDER BY id DESC LIMIT 100')).map(toSummary));
}));
reposRouter.get('/:id', asyncRoute(async (req, res) => {
  const [row] = await query('SELECT * FROM repositories WHERE id=$1', [positiveId(req.params.id)]);
  if (!row) throw new HttpError(404, 'repository not found');
  res.json(toSummary(row));
}));
reposRouter.get('/:id/jobs', asyncRoute(async (req, res) => {
  res.json((await query('SELECT * FROM jobs WHERE repository_id=$1 ORDER BY id DESC LIMIT 20', [positiveId(req.params.id)])).map(toJob));
}));

async function checkQuota(): Promise<void> {
  const [{ n }] = await query<{ n: number }>('SELECT COUNT(*) AS n FROM repositories');
  if (n >= MAX_REPOSITORIES) throw new HttpError(409, 'repository quota reached; delete an existing repository first');
}

reposRouter.post('/clone', asyncRoute(async (req, res) => {
  const url = validateRemoteUrl(String(req.body?.url ?? '').trim());
  await checkQuota();
  const [row] = await query<{ id: number; repository_id: number }>(`WITH repo AS (
    INSERT INTO repositories(name,source_type,source_url) VALUES ($1,'clone',$2) RETURNING id)
    INSERT INTO jobs(repository_id) SELECT id FROM repo RETURNING id,repository_id`, [repoNameFromUrl(url), url]);
  await query('UPDATE repositories SET path=$1 WHERE id=$2', [path.join(REPOS_DIR, String(row.repository_id)), row.repository_id]);
  await wakeWorker();
  res.status(202).json({ repositoryId: row.repository_id, jobId: row.id });
}));

reposRouter.post('/upload', asyncRoute(async (req, res) => {
  await checkQuota();
  if (Number(req.headers['content-length'] ?? 0) > MAX_UPLOAD_BYTES) throw new HttpError(413, 'upload exceeds size limit');
  const name = String(req.headers['x-filename'] ?? 'upload.zip');
  if (!name.toLowerCase().endsWith('.zip')) throw new HttpError(400, 'a .zip file containing .git is required');
  const [{ id }] = await query<{ id: number }>(
    `INSERT INTO repositories(name,source_type) VALUES ($1,'zip') RETURNING id`, [repoNameFromZip(name)]);
  const zipPath = path.join(UPLOADS_DIR, `repo-${id}.zip`);
  const out = fs.createWriteStream(zipPath, { flags: 'wx' });
  const finished = new Promise<void>((resolve, reject) => {
    out.once('finish', resolve);
    out.once('error', reject);
  });
  // Attach a rejection handler immediately, before the upload starts.
  void finished.catch(() => undefined);
  let bytes = 0;
  try {
    for await (const chunk of req) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_UPLOAD_BYTES) throw new HttpError(413, 'upload exceeds size limit');
      if (!out.write(chunk)) await once(out, 'drain');
    }
    out.end();
    await finished;
    await query('UPDATE repositories SET source_url=$1,path=$2 WHERE id=$3',
      [zipPath, path.join(REPOS_DIR, String(id)), id]);
    const jobId = await enqueue(id);
    await wakeWorker();
    res.status(202).json({ repositoryId: id, jobId });
  } catch (error) {
    out.destroy();
    await fs.promises.rm(zipPath, { force: true });
    await query(`UPDATE repositories SET status='error',error='upload failed or interrupted' WHERE id=$1`, [id]);
    throw error;
  }
}));

reposRouter.delete('/:id', asyncRoute(async (req, res) => {
  const id = positiveId(req.params.id);
  const [row] = await query('SELECT status FROM repositories WHERE id=$1', [id]);
  if (!row) throw new HttpError(404, 'repository not found');
  if (row.status === 'pending' || row.status === 'ingesting') throw new HttpError(409, 'wait for ingestion to finish before deleting');
  await removeRepositoryFiles(id);
  await query('DELETE FROM repositories WHERE id=$1', [id]);
  res.json({ ok: true });
}));
