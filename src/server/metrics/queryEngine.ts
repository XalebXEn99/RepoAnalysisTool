import { db } from '../db/connection';
import type {
  AuthorInfo,
  AuthorMetricRow,
  CommitInfo,
  MetricFilters,
  ObjectInfo,
  ObjectKind,
  ObjectMetrics,
  TimelinePoint,
} from '../../shared/types';

/**
 * Metric evaluation over a commit set H (test_brief.md §2).
 *
 * Semantics implemented here:
 *  - H is restricted by repository + committer-date range (H_t / H_{i,j})
 *    and/or an explicit commit hash list.
 *  - An author filter restricts which commits' deltas are summed
 *    (sum over h in H with a = h[a]); because every commit has exactly one
 *    author, per-(commit,object) rows never mix authors, so no re-aggregation
 *    is required and n_{H,o,a} is a plain distinct-commit count.
 *  - |H| used by eta and rho is the filtered commit count; with an author
 *    filter it is the number of commits in H by that author.
 *  - Author breakdowns (omega) are always evaluated over H without the
 *    author filter so ownership fractions sum to 1.
 */

interface CommitPredicate {
  sql: string; // conditions on alias `c` (commits)
  params: unknown[];
}

function commitPredicate(filters: MetricFilters, includeAuthor = true): CommitPredicate {
  const conds: string[] = ['c.repository_id = ?'];
  const params: unknown[] = [filters.repoId];
  if (filters.from !== undefined) {
    conds.push('c.committer_date >= ?');
    params.push(filters.from);
  }
  if (filters.to !== undefined) {
    conds.push('c.committer_date < ?');
    params.push(filters.to);
  }
  if (filters.commitHashes && filters.commitHashes.length > 0) {
    conds.push(`c.hash IN (${filters.commitHashes.map(() => '?').join(',')})`);
    params.push(...filters.commitHashes);
  }
  if (includeAuthor && filters.authorId !== undefined) {
    conds.push('c.author_id IN (SELECT id FROM authors WHERE canonical_id = ?)');
    params.push(filters.authorId);
  }
  return { sql: conds.join(' AND '), params };
}

/** |H| for the active filter set. */
export function commitSetSize(filters: MetricFilters): number {
  const p = commitPredicate(filters);
  const row = db().prepare(`SELECT COUNT(*) AS n FROM commits c WHERE ${p.sql}`).get(...p.params) as { n: number };
  return row.n;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

interface RawAgg {
  path: string;
  kind: ObjectKind;
  added: number;
  removed: number;
  churn: number;
  modifications: number;
}

function toObjectMetrics(raw: RawAgg, setSize: number): ObjectMetrics {
  const churn = raw.churn;
  return {
    path: raw.path,
    kind: raw.kind,
    added: raw.added,
    removed: raw.removed,
    growth: raw.added - raw.removed, // delta_{H,o}
    churn, // lambda_{H,o}
    modifications: raw.modifications, // n_{H,o}
    modificationFrequency: setSize === 0 ? 0 : raw.modifications / setSize, // eta_{H,o}
    churnRate: setSize === 0 ? 0 : churn / setSize, // rho_{H,o}
    commitCount: setSize,
  };
}

const AGG_SELECT = `
  SELECT o.path AS path, o.kind AS kind,
         COALESCE(SUM(ch.added), 0)   AS added,
         COALESCE(SUM(ch.removed), 0) AS removed,
         COALESCE(SUM(ch.added + ch.removed), 0) AS churn,
         COUNT(DISTINCT c.id)         AS modifications
  FROM changes ch
  JOIN commits c ON c.id = ch.commit_id
  JOIN objects o ON o.id = ch.object_id
`;

/** Kind of a registered object, or null when the repository never contained it. */
function objectKind(repoId: number, objectPath: string): ObjectKind | null {
  const row = db()
    .prepare('SELECT kind FROM objects WHERE repository_id = ? AND path = ?')
    .get(repoId, objectPath) as { kind: ObjectKind } | undefined;
  return row?.kind ?? null;
}

/** Metrics for a single object (file, directory, or '' = repository root). */
export function getObjectMetrics(filters: MetricFilters, objectPath: string): ObjectMetrics | null {
  const kind = objectKind(filters.repoId, objectPath);
  if (kind === null) return null; // unknown object: the route answers 404
  const setSize = commitSetSize(filters);
  const p = commitPredicate(filters);
  // An aggregate without GROUP BY always yields one row, so an object that has
  // no changes inside H comes back zeroed rather than missing; path and kind
  // are taken from the objects table because the join may have matched nothing.
  const row = (db()
    .prepare(
      `${AGG_SELECT}
       WHERE ch.repository_id = ? AND o.repository_id = ? AND o.path = ? AND ${p.sql}`,
    )
    .get(filters.repoId, filters.repoId, objectPath, ...p.params) ?? {}) as Partial<RawAgg>;
  return toObjectMetrics(
    {
      path: objectPath,
      kind,
      added: row.added ?? 0,
      removed: row.removed ?? 0,
      churn: row.churn ?? 0,
      modifications: row.modifications ?? 0,
    },
    setSize,
  );
}

/** Immediate children of a directory ('' = root), i.e. the directory table. */
export function listChildren(filters: MetricFilters, dirPath: string, limit = 500): ObjectMetrics[] {
  const setSize = commitSetSize(filters);
  const p = commitPredicate(filters);
  const prefix = dirPath === '' ? '' : `${dirPath}/`;
  const rows = db()
    .prepare(
      `${AGG_SELECT}
       WHERE ch.repository_id = ? AND o.repository_id = ? AND o.path != ?
         AND o.path LIKE ? ESCAPE '\\' AND o.path NOT LIKE ? ESCAPE '\\'
         AND ${p.sql}
       GROUP BY o.id
       ORDER BY (COALESCE(SUM(ch.added),0) + COALESCE(SUM(ch.removed),0)) DESC, o.path ASC
       LIMIT ?`,
    )
    .all(
      filters.repoId,
      filters.repoId,
      dirPath,
      `${escapeLike(prefix)}%`,
      `${escapeLike(prefix)}%/%`,
      ...p.params,
      limit,
    ) as RawAgg[];
  return rows.map((r) => toObjectMetrics(r, setSize));
}

/** Top-N objects repository wide, for charts and hot-spot tables. */
export function listTop(
  filters: MetricFilters,
  by: 'churn' | 'modifications',
  kind: ObjectKind,
  limit = 10,
): ObjectMetrics[] {
  const setSize = commitSetSize(filters);
  const p = commitPredicate(filters);
  const order = by === 'churn' ? 'churn' : 'modifications';
  const rows = db()
    .prepare(
      `${AGG_SELECT}
       WHERE ch.repository_id = ? AND o.repository_id = ? AND o.kind = ? AND o.path != '' AND ${p.sql}
       GROUP BY o.id
       ORDER BY ${order} DESC, o.path ASC
       LIMIT ?`,
    )
    .all(filters.repoId, filters.repoId, kind, ...p.params, limit) as RawAgg[];
  return rows.map((r) => toObjectMetrics(r, setSize));
}

/** Author breakdown of one object: n_{H,o,a}, lambda_{H,o,a}, omega_{H,o,a}. */
export function listAuthorsForObject(filters: MetricFilters, objectPath: string): AuthorMetricRow[] {
  const withoutAuthor: MetricFilters = { ...filters, authorId: undefined };
  const p = commitPredicate(withoutAuthor);
  const rows = db()
    .prepare(
      `SELECT ca.id AS authorId, ca.name AS authorName,
              COALESCE(SUM(ch.added + ch.removed), 0) AS churn,
              COUNT(DISTINCT c.id) AS modifications
       FROM changes ch
       JOIN commits c  ON c.id = ch.commit_id
       JOIN objects o  ON o.id = ch.object_id
       JOIN authors a  ON a.id = c.author_id
       JOIN authors ca ON ca.id = a.canonical_id
       WHERE ch.repository_id = ? AND o.repository_id = ? AND o.path = ? AND ${p.sql}
       GROUP BY ca.id
       ORDER BY churn DESC, ca.name ASC, ca.id ASC`,
    )
    .all(filters.repoId, filters.repoId, objectPath, ...p.params) as Array<{
    authorId: number;
    authorName: string;
    churn: number;
    modifications: number;
  }>;
  const totalChurn = rows.reduce((sum, r) => sum + r.churn, 0);
  return rows.map((r) => ({
    authorId: r.authorId,
    authorName: r.authorName,
    modifications: r.modifications,
    churn: r.churn,
    // omega_{H,o,a} = lambda_{H,o,a} / lambda_{H,o}, 0 when lambda_{H,o} = 0
    ownership: totalChurn === 0 ? 0 : r.churn / totalChurn,
  }));
}

/** Month-bucketed churn/add/remove timeline for one object. */
export function getTimeline(filters: MetricFilters, objectPath: string): TimelinePoint[] {
  const p = commitPredicate(filters);
  const rows = db()
    .prepare(
      `SELECT strftime('%Y-%m', c.committer_date, 'unixepoch') AS label,
              COALESCE(SUM(ch.added), 0)   AS added,
              COALESCE(SUM(ch.removed), 0) AS removed,
              COUNT(DISTINCT c.id)         AS commits
       FROM changes ch
       JOIN commits c ON c.id = ch.commit_id
       JOIN objects o ON o.id = ch.object_id
       WHERE ch.repository_id = ? AND o.repository_id = ? AND o.path = ? AND ${p.sql}
       GROUP BY label
       ORDER BY label`,
    )
    .all(filters.repoId, filters.repoId, objectPath, ...p.params) as Array<{
    label: string;
    added: number;
    removed: number;
    commits: number;
  }>;
  return rows.map((r) => {
    const [year, month] = r.label.split('-').map(Number);
    return {
      label: r.label,
      bucket: Date.UTC(year, month - 1, 1) / 1000,
      added: r.added,
      removed: r.removed,
      churn: r.added + r.removed,
      commits: r.commits,
    };
  });
}

/**
 * Commits of H, newest first. Rows are inserted in the order git reported them,
 * so breaking a committer-date tie on id keeps that order instead of letting
 * SQLite reshuffle equal timestamps between identical queries.
 */
export function listCommits(filters: MetricFilters, limit = 200): CommitInfo[] {
  const p = commitPredicate(filters, false);
  const rows = db()
    .prepare(
      `SELECT c.id AS id, c.hash AS hash, c.committer_date AS committerDate, c.is_merge AS isMerge,
              c.subject AS subject, ca.id AS authorId, ca.name AS authorName
       FROM commits c
       JOIN authors a  ON a.id = c.author_id
       JOIN authors ca ON ca.id = a.canonical_id
       WHERE ${p.sql}
       ORDER BY c.committer_date DESC, c.id ASC
       LIMIT ?`,
    )
    .all(...p.params, limit) as Array<{
    id: number;
    hash: string;
    committerDate: number;
    isMerge: number;
    subject: string;
    authorId: number;
    authorName: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    hash: r.hash,
    shortHash: r.hash.slice(0, 8),
    authorId: r.authorId,
    authorName: r.authorName,
    committerDate: r.committerDate,
    isMerge: r.isMerge === 1,
    subject: r.subject,
  }));
}

export function listAuthors(repoId: number): AuthorInfo[] {
  const rows = db()
    .prepare(
      `SELECT a.id AS id, a.name AS name, a.email AS email, a.canonical_id AS canonicalId,
              ca.name AS canonicalName, a.merge_source AS mergeSource,
              (SELECT COUNT(*) FROM commits c WHERE c.author_id = a.id) AS commitCount,
              COALESCE((
                SELECT SUM(ch.added + ch.removed)
                FROM changes ch JOIN commits c ON c.id = ch.commit_id
                WHERE c.author_id = a.id AND ch.repository_id = ?
                  AND ch.object_id = (SELECT id FROM objects WHERE repository_id = ? AND path = '')
              ), 0) AS churn
       FROM authors a
       JOIN authors ca ON ca.id = a.canonical_id
       WHERE a.repository_id = ?
       ORDER BY churn DESC, a.name ASC`,
    )
    .all(repoId, repoId, repoId) as Array<Omit<AuthorInfo, 'mergeSource'> & { mergeSource: string }>;
  return rows.map((r) => ({ ...r, mergeSource: r.mergeSource as AuthorInfo['mergeSource'] }));
}

export function listObjects(repoId: number, kind: ObjectKind | undefined, prefix: string, limit = 2000): ObjectInfo[] {
  const conds = ['repository_id = ?'];
  const params: unknown[] = [repoId];
  if (kind) {
    conds.push('kind = ?');
    params.push(kind);
  }
  if (prefix) {
    conds.push(`path LIKE ? ESCAPE '\\'`);
    params.push(`${escapeLike(prefix)}%`);
  }
  const rows = db()
    .prepare(`SELECT id, path, kind FROM objects WHERE ${conds.join(' AND ')} ORDER BY path LIMIT ?`)
    .all(...params, limit) as ObjectInfo[];
  return rows;
}
