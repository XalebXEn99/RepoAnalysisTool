import { Router, type Request } from 'express';
import { query } from '../db/connection';
import { commitSetSize, getTimeline, listAuthorsForObject, listChildren, countChildren, listTop, getObjectMetrics } from '../metrics/queryEngine';
import type { MetricFilters } from '../../shared/types';
import { toSummary } from './mappers';
import { asyncRoute, HttpError, pageNumber, positiveId } from '../http';

export const metricsRouter = Router();

export function parseTimestamp(value: unknown): number | undefined {
  if (value === undefined || value === '') return undefined;
  const raw = String(value);
  const number = /^\d+$/.test(raw) ? Number(raw) : Math.floor(Date.parse(raw) / 1000);
  if (!Number.isSafeInteger(number) || number < 0 || number > 253402300799) throw new HttpError(400, 'invalid timestamp');
  return number;
}

export function filtersFrom(req: Request): MetricFilters {
  const from = parseTimestamp(req.query.from);
  const to = parseTimestamp(req.query.to);
  if (from !== undefined && to !== undefined && from > to) throw new HttpError(400, 'from must not exceed to');
  const raw = String(req.query.commits ?? '');
  const hashes = raw ? raw.split(',').map((hash) => hash.trim()) : undefined;
  if (hashes && (hashes.length > 500 || hashes.some((hash) => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(hash)))) {
    throw new HttpError(400, 'select at most 500 valid full commit hashes');
  }
  return {
    repoId: positiveId(req.query.repo ?? req.query.repoId),
    authorId: req.query.author ? positiveId(req.query.author) : undefined,
    from, to, commitHashes: hashes,
  };
}

metricsRouter.use((req, _res, next) => {
  void (async () => {
    const [repo] = await query('SELECT status FROM repositories WHERE id=$1', [positiveId(req.query.repo ?? req.query.repoId)]);
    if (!repo) throw new HttpError(404, 'repository not found');
    if (repo.status !== 'ready') throw new HttpError(409, 'repository analysis is not ready');
  })().then(() => next(), next);
});

metricsRouter.get('/summary', asyncRoute(async (req, res) => {
  const filters = filtersFrom(req);
  const [repository] = await query('SELECT * FROM repositories WHERE id=$1', [filters.repoId]);
  const size = await commitSetSize(filters);
  const [root, authors, topChurn, topModified, timeline] = await Promise.all([
    getObjectMetrics(filters, '', size), listAuthorsForObject(filters, ''),
    listTop(filters, 'churn', 'file', 10, size), listTop(filters, 'modifications', 'file', 10, size), getTimeline(filters, ''),
  ]);
  if (!root) throw new HttpError(409, 'repository index is incomplete');
  res.json({ repository: toSummary(repository), root, authors, topChurn, topModified, timeline, commitCount: root.commitCount });
}));

metricsRouter.get('/object', asyncRoute(async (req, res) => {
  const filters = filtersFrom(req);
  const path = String(req.query.path ?? '');
  const metrics = await getObjectMetrics(filters, path);
  if (!metrics) throw new HttpError(404, 'object has no recorded changes');
  const [authors, timeline] = await Promise.all([listAuthorsForObject(filters, path), getTimeline(filters, path)]);
  res.json({ repositoryId: filters.repoId, path, kind: metrics.kind, metrics, authors, timeline });
}));

metricsRouter.get('/children', asyncRoute(async (req, res) => {
  const filters = filtersFrom(req);
  const path = String(req.query.path ?? '');
  const limit = Math.max(1, pageNumber(req.query.limit, 100, 500));
  const offset = pageNumber(req.query.offset, 0, 10000000);
  const [children, total] = await Promise.all([listChildren(filters, path, limit, offset), countChildren(filters, path)]);
  res.json({ repositoryId: filters.repoId, path, children, total });
}));

metricsRouter.get('/top', asyncRoute(async (req, res) => {
  res.json(await listTop(filtersFrom(req), req.query.by === 'modifications' ? 'modifications' : 'churn',
    req.query.kind === 'dir' ? 'dir' : 'file', Math.max(1, pageNumber(req.query.limit, 10, 100))));
}));
metricsRouter.get('/timeline', asyncRoute(async (req, res) => {
  res.json(await getTimeline(filtersFrom(req), String(req.query.path ?? '')));
}));
metricsRouter.get('/authors', asyncRoute(async (req, res) => {
  res.json(await listAuthorsForObject(filtersFrom(req), String(req.query.path ?? '')));
}));

export { commitSetSize };
