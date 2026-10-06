import { Router, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { REPOS_DIR, UPLOADS_DIR } from '../config';
import { db } from '../db/connection';
import { jobManager } from '../jobs/jobManager';
import { ingestRepository } from '../ingest/ingestionService';
import { repoNameFromUrl, repoNameFromZip } from '../ingest/gitSource';
import { toJob, toSummary } from './mappers';

export const reposRouter = Router();

reposRouter.get('/', (_req: Request, res: Response) => {
  const rows = db().prepare('SELECT * FROM repositories ORDER BY id DESC').all() as Record<string, unknown>[];
  res.json(rows.map(toSummary));
});

reposRouter.get('/:id', (req: Request, res: Response) => {
  const row = db().prepare('SELECT * FROM repositories WHERE id = ?').get(req.params.id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return res.status(404).json({ error: 'repository not found' });
  res.json(toSummary(row));
});

reposRouter.get('/:id/jobs', (req: Request, res: Response) => {
  const rows = db()
    .prepare('SELECT * FROM jobs WHERE repository_id = ? ORDER BY id DESC LIMIT 20')
    .all(req.params.id) as Record<string, unknown>[];
  res.json(rows.map(toJob));
});

reposRouter.post('/clone', (req: Request, res: Response) => {
  const url = String(req.body?.url ?? '').trim();
  if (!url) return res.status(400).json({ error: 'field "url" is required' });
  if (!/^(https?|git|ssh):\/\//.test(url)) {
    return res.status(400).json({ error: 'url must be an http(s), git or ssh remote' });
  }
  const info = db()
    .prepare(
      `INSERT INTO repositories (name, source_type, source_url, path, status)
       VALUES (?, 'clone', ?, ?, 'pending')`,
    )
    .run(repoNameFromUrl(url), url, '');
  const repoId = Number(info.lastInsertRowid);
  const dest = path.join(REPOS_DIR, String(repoId));
  db().prepare('UPDATE repositories SET path = ? WHERE id = ?').run(dest, repoId);
  const jobId = jobManager.enqueue(repoId, (handle) => ingestRepository(repoId, handle));
  res.status(202).json({ repositoryId: repoId, jobId });
});

/** Body is the raw zip byte stream; filename travels in the x-filename header. */
reposRouter.post('/upload', (req: Request, res: Response) => {
  const fileName = String(req.headers['x-filename'] ?? 'upload.zip');
  const info = db()
    .prepare(
      `INSERT INTO repositories (name, source_type, source_url, path, status)
       VALUES (?, 'zip', ?, ?, 'pending')`,
    )
    .run(repoNameFromZip(fileName), '', '');
  const repoId = Number(info.lastInsertRowid);
  const zipPath = path.join(UPLOADS_DIR, `repo-${repoId}.zip`);
  const dest = path.join(REPOS_DIR, String(repoId));
  db().prepare('UPDATE repositories SET source_url = ?, path = ? WHERE id = ?').run(zipPath, dest, repoId);

  const out = fs.createWriteStream(zipPath);
  req.pipe(out);
  out.on('error', (err) => {
    db().prepare(`UPDATE repositories SET status = 'error', error = ? WHERE id = ?`).run(err.message, repoId);
  });
  out.on('finish', () => {
    const jobId = jobManager.enqueue(repoId, (handle) => ingestRepository(repoId, handle));
    res.status(202).json({ repositoryId: repoId, jobId });
  });
});

reposRouter.delete('/:id', (req: Request, res: Response) => {
  const row = db().prepare('SELECT * FROM repositories WHERE id = ?').get(req.params.id) as
    | { path: string }
    | undefined;
  if (!row) return res.status(404).json({ error: 'repository not found' });
  db().prepare('DELETE FROM repositories WHERE id = ?').run(req.params.id);
  fs.rmSync(row.path, { recursive: true, force: true });
  res.json({ ok: true });
});
