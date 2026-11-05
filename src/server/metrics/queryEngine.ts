import { query } from '../db/connection';
import type { AuthorInfo, AuthorMetricRow, CommitInfo, MetricFilters, ObjectInfo, ObjectKind, ObjectMetrics, TimelinePoint } from '../../shared/types';

function predicate(filters: MetricFilters, params: unknown[], includeAuthor = true): string {
  const bind = (value: unknown) => { params.push(value); return `$${params.length}`; };
  const clauses = [`c.repository_id=${bind(filters.repoId)}`];
  if (filters.from !== undefined) clauses.push(`c.committer_date >= ${bind(filters.from)}`);
  if (filters.to !== undefined) clauses.push(`c.committer_date < ${bind(filters.to)}`);
  if (filters.commitHashes?.length) clauses.push(`c.hash = ANY(${bind(filters.commitHashes)}::text[])`);
  if (includeAuthor && filters.authorId !== undefined) {
    clauses.push(`c.author_id IN (SELECT id FROM authors WHERE canonical_id=${bind(filters.authorId)} AND repository_id=c.repository_id)`);
  }
  return clauses.join(' AND ');
}

export async function commitSetSize(filters: MetricFilters): Promise<number> {
  const params: unknown[] = [];
  const where = predicate(filters, params);
  return (await query<{ n: number }>(`SELECT COUNT(*) AS n FROM commits c WHERE ${where}`, params))[0].n;
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

function toMetrics(row: RawAgg, setSize: number): ObjectMetrics {
  return {
    ...row, growth: row.added - row.removed,
    modificationFrequency: setSize ? row.modifications / setSize : 0,
    churnRate: setSize ? row.churn / setSize : 0,
    commitCount: setSize,
  };
}

const AGG = `SELECT o.path,o.kind,COALESCE(SUM(ch.added),0) AS added,
  COALESCE(SUM(ch.removed),0) AS removed,COALESCE(SUM(ch.added+ch.removed),0) AS churn,
  COUNT(DISTINCT c.id) AS modifications
  FROM changes ch JOIN commits c ON c.id=ch.commit_id JOIN objects o ON o.id=ch.object_id`;

export async function getObjectMetrics(filters: MetricFilters, objectPath: string, setSize?: number): Promise<ObjectMetrics | null> {
  const [object] = await query<{ kind: ObjectKind }>(
    'SELECT kind FROM objects WHERE repository_id=$1 AND path=$2', [filters.repoId, objectPath],
  );
  if (!object) return null;
  const params: unknown[] = [objectPath];
  const where = predicate(filters, params);
  const [row] = await query<RawAgg>(
    `${AGG} WHERE o.path=$1 AND ${where} GROUP BY o.id`, params,
  );
  return toMetrics(row ?? { path: objectPath, kind: object.kind, added: 0, removed: 0, churn: 0, modifications: 0 }, setSize ?? await commitSetSize(filters));
}

export async function listChildren(filters: MetricFilters, dirPath: string, limit = 100, offset = 0): Promise<ObjectMetrics[]> {
  const prefix = dirPath ? `${dirPath}/` : '';
  const params: unknown[] = [dirPath, `${escapeLike(prefix)}%`, `${escapeLike(prefix)}%/%`, limit, offset];
  const where = predicate(filters, params);
  const rows = await query<RawAgg>(`${AGG}
    WHERE o.path <> $1 AND o.path LIKE $2 ESCAPE '\\' AND o.path NOT LIKE $3 ESCAPE '\\'
      AND ${where}
    GROUP BY o.id ORDER BY churn DESC,o.path ASC LIMIT $4 OFFSET $5`, params);
  const size = await commitSetSize(filters);
  return rows.map((row) => toMetrics(row, size));
}

export async function countChildren(filters: MetricFilters, dirPath: string): Promise<number> {
  const prefix = dirPath ? `${dirPath}/` : '';
  const params: unknown[] = [dirPath, `${escapeLike(prefix)}%`, `${escapeLike(prefix)}%/%`];
  const where = predicate(filters, params);
  return (await query<{ n: number }>(`SELECT COUNT(DISTINCT o.id) AS n
    FROM changes ch JOIN commits c ON c.id=ch.commit_id JOIN objects o ON o.id=ch.object_id
    WHERE o.path <> $1 AND o.path LIKE $2 ESCAPE '\\' AND o.path NOT LIKE $3 ESCAPE '\\' AND ${where}`, params))[0].n;
}

export async function listTop(filters: MetricFilters, by: 'churn' | 'modifications', kind: ObjectKind, limit = 10, setSize?: number): Promise<ObjectMetrics[]> {
  const params: unknown[] = [kind, limit];
  const where = predicate(filters, params);
  const rows = await query<RawAgg>(`${AGG} WHERE o.kind=$1 AND o.path<>'' AND ${where}
    GROUP BY o.id ORDER BY ${by} DESC,o.path ASC LIMIT $2`, params);
  const size = setSize ?? await commitSetSize(filters);
  return rows.map((row) => toMetrics(row, size));
}

export async function listAuthorsForObject(filters: MetricFilters, objectPath: string): Promise<AuthorMetricRow[]> {
  const params: unknown[] = [objectPath];
  const where = predicate(filters, params, false);
  const rows = await query<Omit<AuthorMetricRow, 'ownership'>>(`SELECT ca.id AS "authorId",ca.name AS "authorName",
    COALESCE(SUM(ch.added+ch.removed),0) AS churn,COUNT(DISTINCT c.id) AS modifications
    FROM changes ch JOIN commits c ON c.id=ch.commit_id JOIN objects o ON o.id=ch.object_id
    JOIN authors a ON a.id=c.author_id JOIN authors ca ON ca.id=a.canonical_id
    WHERE o.path=$1 AND ${where}
    GROUP BY ca.id ORDER BY churn DESC,ca.name ASC,ca.id ASC`, params);
  const total = rows.reduce((sum, row) => sum + row.churn, 0);
  return rows.map((row) => ({ ...row, ownership: total ? row.churn / total : 0 }));
}

export async function getTimeline(filters: MetricFilters, objectPath: string): Promise<TimelinePoint[]> {
  const params: unknown[] = [objectPath];
  const where = predicate(filters, params);
  const rows = await query<{ label: string; added: number; removed: number; commits: number }>(`
    SELECT to_char(to_timestamp(c.committer_date) AT TIME ZONE 'UTC','YYYY-MM') AS label,
      SUM(ch.added) AS added,SUM(ch.removed) AS removed,COUNT(DISTINCT c.id) AS commits
    FROM changes ch JOIN commits c ON c.id=ch.commit_id JOIN objects o ON o.id=ch.object_id
    WHERE o.path=$1 AND ${where} GROUP BY label ORDER BY label`, params);
  return rows.map((row) => {
    const [year, month] = row.label.split('-').map(Number);
    return { ...row, bucket: Date.UTC(year, month - 1, 1) / 1000, churn: row.added + row.removed };
  });
}

export async function listCommits(filters: MetricFilters, limit = 100, offset = 0, search = ''): Promise<CommitInfo[]> {
  const params: unknown[] = [limit, offset, `%${escapeLike(search)}%`];
  const where = predicate(filters, params, false);
  const rows = await query<Omit<CommitInfo, 'shortHash' | 'isMerge'>>(`SELECT c.id,c.hash,c.committer_date AS "committerDate",
    c.subject,ca.id AS "authorId",ca.name AS "authorName"
    FROM commits c JOIN authors a ON a.id=c.author_id JOIN authors ca ON ca.id=a.canonical_id
    WHERE ${where} AND (c.hash ILIKE $3 OR c.subject ILIKE $3 OR ca.name ILIKE $3)
    ORDER BY c.committer_date DESC,c.id ASC LIMIT $1 OFFSET $2`, params);
  return rows.map((row) => ({ ...row, shortHash: row.hash.slice(0, 8), isMerge: false }));
}

export async function listAuthors(repoId: number): Promise<AuthorInfo[]> {
  return query<AuthorInfo>(`WITH activity AS (
    SELECT c.author_id,COUNT(*) AS commits,COALESCE(SUM(ch.added+ch.removed),0) AS churn
    FROM commits c LEFT JOIN changes ch ON ch.commit_id=c.id AND ch.object_id=(
      SELECT id FROM objects WHERE repository_id=$1 AND path='')
    WHERE c.repository_id=$1 GROUP BY c.author_id)
    SELECT a.id,a.name,a.email,a.canonical_id AS "canonicalId",ca.name AS "canonicalName",
      a.merge_source AS "mergeSource",COALESCE(x.commits,0) AS "commitCount",COALESCE(x.churn,0) AS churn
    FROM authors a JOIN authors ca ON ca.id=a.canonical_id LEFT JOIN activity x ON x.author_id=a.id
    WHERE a.repository_id=$1 ORDER BY churn DESC,a.name ASC,a.id ASC`, [repoId]);
}

export async function listObjects(repoId: number, kind: ObjectKind | undefined, prefix: string, limit = 2000): Promise<ObjectInfo[]> {
  return query<ObjectInfo>(`SELECT id,path,kind FROM objects
    WHERE repository_id=$1 AND ($2::text IS NULL OR kind=$2) AND path LIKE $3 ESCAPE '\\'
    ORDER BY path LIMIT $4`, [repoId, kind ?? null, `${escapeLike(prefix)}%`, limit]);
}
