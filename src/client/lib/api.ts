import type {
  AuthorInfo,
  AuthorMetricRow,
  ChildrenResponse,
  CommitInfo,
  JobInfo,
  MetricsResponse,
  ObjectInfo,
  ObjectMetrics,
  RepositorySummary,
  SummaryResponse,
  TimelinePoint,
} from '../../shared/types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}

export const api = {
  health: () => request<{ ok: boolean; repositories: number }>('/api/health'),
  listRepos: () => request<RepositorySummary[]>('/api/repos'),
  getRepo: (id: number) => request<RepositorySummary>(`/api/repos/${id}`),
  deleteRepo: (id: number) => request<{ ok: boolean }>(`/api/repos/${id}`, { method: 'DELETE' }),
  cloneRepo: (url: string) =>
    request<{ repositoryId: number; jobId: number }>('/api/repos/clone', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    }),
  uploadRepo: (file: File) =>
    request<{ repositoryId: number; jobId: number }>('/api/repos/upload', {
      method: 'POST',
      headers: { 'x-filename': file.name },
      body: file,
      // @ts-expect-error -- duplex streaming is required for fetch upload bodies in some runtimes
      duplex: 'half',
    }),
  jobs: (repoId: number) => request<JobInfo[]>(`/api/repos/${repoId}/jobs`),
  authors: (repoId: number) => request<AuthorInfo[]>(`/api/repos/${repoId}/authors`),
  mergeAuthors: (repoId: number, sourceIds: number[], targetId: number) =>
    request<AuthorInfo[]>(`/api/repos/${repoId}/authors/merge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceIds, targetId }),
    }),
  commits: (repoId: number, limit = 200) => request<CommitInfo[]>(`/api/repos/${repoId}/commits?limit=${limit}`),
  objects: (repoId: number, kind?: string, prefix?: string) =>
    request<ObjectInfo[]>(`/api/repos/${repoId}/objects${query({ kind, prefix })}`),
  summary: (q: string) => request<SummaryResponse>(`/api/metrics/summary${q}`),
  object: (q: string) => request<MetricsResponse>(`/api/metrics/object${q}`),
  children: (q: string) => request<ChildrenResponse>(`/api/metrics/children${q}`),
  top: (q: string) => request<ObjectMetrics[]>(`/api/metrics/top${q}`),
  timeline: (q: string) => request<TimelinePoint[]>(`/api/metrics/timeline${q}`),
  objectAuthors: (q: string) => request<AuthorMetricRow[]>(`/api/metrics/authors${q}`),
};
