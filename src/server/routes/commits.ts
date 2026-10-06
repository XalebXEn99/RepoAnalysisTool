import { Router, type Request, type Response } from 'express';
import { listCommits, listObjects } from '../metrics/queryEngine';
import type { ObjectKind } from '../../shared/types';

export const browseRouter = Router();

function parseTimestamp(value: unknown): number | undefined {
  if (value === undefined || value === '') return undefined;
  const raw = String(value);
  if (/^\d+$/.test(raw)) return Number(raw);
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

/** Commit list for the manual commit-set picker (H-bar only: non-merge). */
browseRouter.get('/:id/commits', (req: Request, res: Response) => {
  const repoId = Number(req.params.id);
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit ?? 200) || 200));
  res.json(
    listCommits(
      {
        repoId,
        from: parseTimestamp(req.query.from),
        to: parseTimestamp(req.query.to),
      },
      limit,
    ),
  );
});

/** File/directory browser backing the object filter. */
browseRouter.get('/:id/objects', (req: Request, res: Response) => {
  const repoId = Number(req.params.id);
  const kindRaw = String(req.query.kind ?? '');
  const kind: ObjectKind | undefined = kindRaw === 'file' || kindRaw === 'dir' ? kindRaw : undefined;
  const limit = Math.min(5000, Math.max(1, Number(req.query.limit ?? 2000) || 2000));
  res.json(listObjects(repoId, kind, String(req.query.prefix ?? ''), limit));
});
