/**
 * Shared API contract between the Express backend and the React client.
 * Metric naming follows docs/test_brief.md section 2 exactly:
 *   added      = l+   removed = l-   growth = delta = l+ - l-   churn = lambda = l+ + l-
 */

export type RepoSourceType = 'clone' | 'zip' | 'local';
export type RepoStatus = 'pending' | 'ingesting' | 'ready' | 'error';
export type JobStatus = 'queued' | 'running' | 'done' | 'error';
export type ObjectKind = 'file' | 'dir';

export interface RepositorySummary {
  id: number;
  name: string;
  sourceType: RepoSourceType;
  sourceUrl: string | null;
  headCommit: string | null;
  commitCount: number;
  status: RepoStatus;
  error: string | null;
  createdAt: string;
  ingestedAt: string | null;
}

export interface JobInfo {
  id: number;
  repositoryId: number;
  stage: string;
  progress: number; // 0..1
  message: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AuthorInfo {
  id: number;
  name: string;
  email: string;
  canonicalId: number;
  /** Display name of the canonical author this row is merged into. */
  canonicalName: string;
  mergeSource: 'identity' | 'mailmap' | 'manual';
  commitCount: number;
  churn: number;
}

export interface ObjectInfo {
  id: number;
  path: string;
  kind: ObjectKind;
}

export interface CommitInfo {
  id: number;
  hash: string;
  shortHash: string;
  authorId: number;
  authorName: string;
  committerDate: number; // unix seconds
  isMerge: boolean;
  subject: string;
}

/** The four additive quantities every object carries (brief 2.1/2.2/2.4). */
export interface CoreMetrics {
  added: number; // l+_{H,o}
  removed: number; // l-_{H,o}
  growth: number; // delta_{H,o}
  churn: number; // lambda_{H,o}
}

/** Commit-set level quantities (brief 2.4). */
export interface ObjectMetrics extends CoreMetrics {
  path: string;
  kind: ObjectKind;
  modifications: number; // n_{H,o}
  modificationFrequency: number; // eta_{H,o} = n / |H|
  churnRate: number; // rho_{H,o} = lambda / |H|
  commitCount: number; // |H| as evaluated for this object's repo/filter
}

/** Author breakdown of one object (brief 2.5). */
export interface AuthorMetricRow {
  authorId: number;
  authorName: string;
  modifications: number; // n_{H,o,a}
  churn: number; // lambda_{H,o,a}
  ownership: number; // omega_{H,o,a} = lambda_{H,o,a} / lambda_{H,o}
}

export interface TimelinePoint {
  /** Bucket start as unix seconds (month buckets). */
  bucket: number;
  label: string;
  added: number;
  removed: number;
  churn: number;
  commits: number;
}

export interface MetricsResponse {
  repositoryId: number;
  /** The object these metrics describe ('' = repository root). */
  path: string;
  kind: ObjectKind;
  metrics: ObjectMetrics;
  authors: AuthorMetricRow[];
  timeline: TimelinePoint[];
}

export interface ChildrenResponse {
  repositoryId: number;
  path: string;
  children: ObjectMetrics[];
}

export interface SummaryResponse {
  repository: RepositorySummary;
  /** Repository metrics = directory metrics on the root (brief 2.3). */
  root: ObjectMetrics;
  authors: AuthorMetricRow[];
  topChurn: ObjectMetrics[];
  topModified: ObjectMetrics[];
  timeline: TimelinePoint[];
  commitCount: number;
}

/** Filter set accepted by every metric endpoint (brief section 1). */
export interface MetricFilters {
  repoId: number;
  authorId?: number;
  path?: string;
  from?: number; // inclusive unix seconds
  to?: number; // exclusive unix seconds
  commitHashes?: string[];
}
