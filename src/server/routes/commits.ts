import { Router } from 'express';
import { listCommits, listObjects } from '../metrics/queryEngine';
import { asyncRoute, positiveId, pageNumber, HttpError } from '../http';
import { parseTimestamp } from './metrics';

export const browseRouter = Router();
browseRouter.get('/:id/commits', asyncRoute(async (req, res) => {
  const search = String(req.query.search ?? '');
  if (search.length > 200) throw new HttpError(400, 'search must not exceed 200 characters');
  res.json(await listCommits({
    repoId: positiveId(req.params.id), from: parseTimestamp(req.query.from), to: parseTimestamp(req.query.to),
  }, Math.max(1, pageNumber(req.query.limit, 100, 1000)), pageNumber(req.query.offset, 0, 10000000), search));
}));
browseRouter.get('/:id/objects', asyncRoute(async (req, res) => {
  res.json(await listObjects(positiveId(req.params.id),
    req.query.kind === 'file' || req.query.kind === 'dir' ? req.query.kind : undefined,
    String(req.query.prefix ?? ''), Math.max(1, pageNumber(req.query.limit, 2000, 5000))));
}));
