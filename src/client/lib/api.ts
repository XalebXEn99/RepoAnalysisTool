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
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new Error(body?.error ?? body?.message ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

function addQuery(path: string, params: Record<string, string | number | undefined>): string {
  const [pathname, existing = ''] = path.split('?');
  const search = new URLSearchParams(existing);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized ? `${pathname}?${serialized}` : pathname;
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
  authors: (repoId: number, signal?: AbortSignal) =>
    request<AuthorInfo[]>(`/api/repos/${repoId}/authors`, { signal }),
  mergeAuthors: (repoId: number, sourceIds: number[], targetId: number) =>
    request<AuthorInfo[]>(`/api/repos/${repoId}/authors/merge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceIds, targetId }),
    }),
  commits: (
    repoId: number,
    limit = 100,
    offset = 0,
    search?: string,
    signal?: AbortSignal,
  ) =>
    request<CommitInfo[]>(
      addQuery(`/api/repos/${repoId}/commits`, { limit, offset, search }),
      { signal },
    ),
  objects: (repoId: number, kind?: string, prefix?: string) =>
    request<ObjectInfo[]>(`/api/repos/${repoId}/objects${query({ kind, prefix })}`),
  summary: (q: string, signal?: AbortSignal) =>
    request<SummaryResponse>(`/api/metrics/summary${q}`, { signal }),
  object: (q: string, signal?: AbortSignal) =>
    request<MetricsResponse>(`/api/metrics/object${q}`, { signal }),
  children: (q: string, limit = 50, offset = 0, signal?: AbortSignal) =>
    request<ChildrenResponse>(
      addQuery(`/api/metrics/children${q}`, { limit, offset }),
      { signal },
    ),
  top: (q: string) => request<ObjectMetrics[]>(`/api/metrics/top${q}`),
  timeline: (q: string) => request<TimelinePoint[]>(`/api/metrics/timeline${q}`),
  objectAuthors: (q: string) => request<AuthorMetricRow[]>(`/api/metrics/authors${q}`),
};
