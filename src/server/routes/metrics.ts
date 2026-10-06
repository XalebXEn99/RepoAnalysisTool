import { Router, type Request, type Response } from 'express';
import { db } from '../db/connection';
import {
  commitSetSize,
  getTimeline,
  listAuthorsForObject,
  listChildren,
  listTop,
  getObjectMetrics,
} from '../metrics/queryEngine';
import type { MetricFilters, ObjectKind } from '../../shared/types';

export const metricsRouter = Router();

function parseTimestamp(value: unknown): number | undefined {
  if (value === undefined || value === '') return undefined;
  const raw = String(value);
  if (/^\d+$/.test(raw)) return Number(raw);
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

function filtersFrom(req: Request): { filters?: MetricFilters; error?: string; path: string } {
  const repoId = Number(req.query.repo ?? req.query.repoId);
  if (!Number.isFinite(repoId) || repoId <= 0) {
    return { error: 'query parameter "repo" (repository id) is required', path: '' };
  }
  const authorRaw = req.query.author;
  const authorId = authorRaw === undefined || authorRaw === '' ? undefined : Number(authorRaw);
  const commitsRaw = String(req.query.commits ?? '');
  const commitHashes = commitsRaw ? commitsRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  return {
    path: String(req.query.path ?? ''),
    filters: {
      repoId,
      authorId: authorId !== undefined && Number.isFinite(authorId) ? authorId : undefined,
      from: parseTimestamp(req.query.from),
      to: parseTimestamp(req.query.to),
      commitHashes,
    },
  };
}

function repoOr404(repoId: number) {
  return db().prepare('SELECT * FROM repositories WHERE id = ?').get(repoId) as
    | Record<string, unknown>
    | undefined;
}

metricsRouter.get('/summary', (req: Request, res: Response) => {
  const { filters, error } = filtersFrom(req);
  if (!filters) return res.status(400).json({ error });
  const repository = repoOr404(filters.repoId);
  if (!repository) return res.status(404).json({ error: 'repository not found' });
  const root = getObjectMetrics(filters, '');
  res.json({
    repository,
    root:
      root ?? {
        path: '',
        kind: 'dir',
        added: 0,
        removed: 0,
        growth: 0,
        churn: 0,
        modifications: 0,
        modificationFrequency: 0,
        churnRate: 0,
        commitCount: 0,
      },
    authors: listAuthorsForObject(filters, ''),
    topChurn: listTop(filters, 'churn', 'file', 10),
    topModified: listTop(filters, 'modifications', 'file', 10),
    timeline: getTimeline(filters, ''),
    commitCount: commitSetSize(filters),
  });
});

metricsRouter.get('/object', (req: Request, res: Response) => {
  const { filters, error, path } = filtersFrom(req);
  if (!filters) return res.status(400).json({ error });
  const metrics = getObjectMetrics(filters, path);
  if (!metrics) return res.status(404).json({ error: `object "${path}" has no recorded changes` });
  res.json({
    repositoryId: filters.repoId,
    path,
    kind: metrics.kind,
    metrics,
    authors: listAuthorsForObject(filters, path),
    timeline: getTimeline(filters, path),
  });
});

metricsRouter.get('/children', (req: Request, res: Response) => {
  const { filters, error, path } = filtersFrom(req);
  if (!filters) return res.status(400).json({ error });
  res.json({ repositoryId: filters.repoId, path, children: listChildren(filters, path) });
});

metricsRouter.get('/top', (req: Request, res: Response) => {
  const { filters, error } = filtersFrom(req);
  if (!filters) return res.status(400).json({ error });
  const by = req.query.by === 'modifications' ? 'modifications' : 'churn';
  const kind: ObjectKind = req.query.kind === 'dir' ? 'dir' : 'file';
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 10) || 10));
  res.json(listTop(filters, by, kind, limit));
});

metricsRouter.get('/timeline', (req: Request, res: Response) => {
  const { filters, error, path } = filtersFrom(req);
  if (!filters) return res.status(400).json({ error });
  res.json(getTimeline(filters, path));
});

metricsRouter.get('/authors', (req: Request, res: Response) => {
  const { filters, error, path } = filtersFrom(req);
  if (!filters) return res.status(400).json({ error });
  res.json(listAuthorsForObject(filters, path));
});
