import type { JobInfo, RepositorySummary } from '../../shared/types';

/**
 * Row -> API contract mappers. SQLite columns are snake_case; the client and
 * src/shared/types.ts are camelCase, so every route must translate through
 * these instead of returning raw rows.
 */

export function toSummary(row: Record<string, unknown>): RepositorySummary {
  return {
    id: row.id as number,
    name: row.name as string,
    sourceType: row.source_type as RepositorySummary['sourceType'],
    sourceUrl: (row.source_url as string | null) ?? null,
    headCommit: (row.head_commit as string | null) ?? null,
    commitCount: row.commit_count as number,
    status: row.status as RepositorySummary['status'],
    error: (row.error as string | null) ?? null,
    createdAt: row.created_at as string,
    ingestedAt: (row.ingested_at as string | null) ?? null,
  };
}

export function toJob(row: Record<string, unknown>): JobInfo {
  return {
    id: row.id as number,
    repositoryId: row.repository_id as number,
    stage: row.stage as string,
    progress: row.progress as number,
    message: row.message as string,
    status: row.status as JobInfo['status'],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}
