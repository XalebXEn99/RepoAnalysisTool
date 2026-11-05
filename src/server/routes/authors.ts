import { Router } from 'express';
import { query } from '../db/connection';
import { listAuthors } from '../metrics/queryEngine';
import { asyncRoute, positiveId, HttpError } from '../http';

export const authorsRouter = Router();
authorsRouter.get('/:id/authors', asyncRoute(async (req, res) => {
  res.json(await listAuthors(positiveId(req.params.id)));
}));
authorsRouter.post('/:id/authors/merge', asyncRoute(async (req, res) => {
  const repoId = positiveId(req.params.id);
  const { sourceIds, targetId } = req.body as { sourceIds?: unknown; targetId?: unknown };
  if (!Array.isArray(sourceIds) || !sourceIds.length || sourceIds.length > 500) {
    throw new HttpError(400, 'sourceIds must contain 1 to 500 author ids');
  }
  const sources = sourceIds.map(positiveId);
  const target = positiveId(targetId);
  const [repo] = await query('SELECT status FROM repositories WHERE id=$1', [repoId]);
  if (!repo || repo.status !== 'ready') throw new HttpError(409, 'repository is not ready');
  const rows = await query<{ id: number; canonical_id: number }>(
    'SELECT id,canonical_id FROM authors WHERE repository_id=$1 AND id=ANY($2::int[])',
    [repoId, [...sources, target]],
  );
  const targetRow = rows.find((row) => row.id === target);
  if (!targetRow || sources.some((id) => !rows.some((row) => row.id === id))) throw new HttpError(404, 'author not found in repository');
  const canonicalSources = rows.filter((row) => sources.includes(row.id)).map((row) => row.canonical_id);
  await query(`WITH saved AS (
    INSERT INTO manual_author_merges(repository_id,source_name,source_email,target_name,target_email)
    SELECT $2,a.name,a.email,t.name,t.email FROM authors a,authors t
    WHERE t.id=$1 AND a.repository_id=$2 AND (a.id=ANY($3::int[]) OR a.canonical_id=ANY($4::int[]))
    ON CONFLICT(repository_id,source_name,source_email) DO UPDATE
    SET target_name=EXCLUDED.target_name,target_email=EXCLUDED.target_email)
    UPDATE authors SET canonical_id=$1,merge_source='manual'
    WHERE repository_id=$2 AND (id=ANY($3::int[]) OR canonical_id=ANY($4::int[]))`,
  [targetRow.canonical_id, repoId, sources, canonicalSources]);
  res.json(await listAuthors(repoId));
}));
