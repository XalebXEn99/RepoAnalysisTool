import { Router, type Request, type Response } from 'express';
import { db } from '../db/connection';
import { listAuthors } from '../metrics/queryEngine';

export const authorsRouter = Router();

authorsRouter.get('/:id/authors', (req: Request, res: Response) => {
  res.json(listAuthors(Number(req.params.id)));
});

/**
 * Manual author merge (docs/test_brief.md §1): fold the selected author rows and
 * their existing groups into the target's canonical identity. Metrics pick
 * this up immediately because every aggregation joins on canonical_id.
 */
authorsRouter.post('/:id/authors/merge', (req: Request, res: Response) => {
  const repoId = Number(req.params.id);
  const { sourceIds, targetId } = req.body as { sourceIds?: number[]; targetId?: number };
  if (!Array.isArray(sourceIds) || sourceIds.length === 0 || targetId === undefined) {
    return res.status(400).json({ error: 'fields "sourceIds" (array) and "targetId" are required' });
  }
  const target = db()
    .prepare('SELECT canonical_id FROM authors WHERE id = ? AND repository_id = ?')
    .get(targetId, repoId) as { canonical_id: number } | undefined;
  if (!target) return res.status(404).json({ error: 'target author not found in this repository' });

  const update = db().prepare(
    `UPDATE authors SET canonical_id = ?, merge_source = 'manual'
     WHERE repository_id = ? AND (id = ? OR canonical_id = ?)`,
  );
  const run = db().transaction((ids: number[]) => {
    for (const sourceId of ids) {
      if (sourceId === targetId) continue;
      update.run(target.canonical_id, repoId, sourceId, sourceId);
    }
  });
  run(sourceIds);
  res.json(listAuthors(repoId));
});
