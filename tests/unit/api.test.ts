import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AuthorInfo,
  ChildrenResponse,
  CommitInfo,
  JobInfo,
  MetricsResponse,
  ObjectInfo,
  ObjectMetrics,
  RepositorySummary,
  SummaryResponse,
  TimelinePoint,
} from '../../src/shared/types';
import { cleanupScratch, createFixtureRepo, EXPECTED, scratchDir, type Fixture } from '../helpers/fixture';

// Isolated scratch database for this suite; must be set before server modules load.
process.env.RAT_DATA_DIR = scratchDir('rat-api-db');

const { createApp } = await import('../../src/server/app');
const { ensureDataDirs } = await import('../../src/server/config');
const { db } = await import('../../src/server/db/connection');
const { ingestRepository } = await import('../../src/server/ingest/ingestionService');

let server: Server | undefined;
let base = '';
let fixture: Fixture;
let repoId = 0;

beforeAll(async () => {
  ensureDataDirs();
  fixture = createFixtureRepo();
  const info = db()
    .prepare(
      `INSERT INTO repositories (name, source_type, source_url, path, status)
       VALUES ('fixture-api', 'local', NULL, ?, 'pending')`,
    )
    .run(fixture.dir);
  repoId = Number(info.lastInsertRowid);
  await ingestRepository(repoId, { jobId: 0, update: () => undefined });
  // Ephemeral port: no clash with a developer's running `npm run dev:server`.
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120000);

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  cleanupScratch(); // also removes the scratch database the app was pointed at
});

function qs(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}

async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: (await res.json()) as T };
}

async function post<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

describe('repository endpoints', () => {
  it('GET /api/health reports the repository count', async () => {
    const { status, body } = await get<{ ok: boolean; repositories: number }>('/api/health');
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, repositories: 1 });
  });

  it('GET /api/repos answers in the camelCase API contract', async () => {
    const { status, body } = await get<RepositorySummary[]>('/api/repos');
    expect(status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      id: repoId,
      name: 'fixture-api',
      sourceType: 'local',
      status: 'ready',
      commitCount: EXPECTED.nonMergeCommits,
    });
    expect(body[0].headCommit).toHaveLength(40);
  });

  it('GET /api/repos/:id and its job list resolve', async () => {
    const repo = await get<RepositorySummary>(`/api/repos/${repoId}`);
    expect(repo.status).toBe(200);
    expect(repo.body.name).toBe('fixture-api');
    const jobs = await get<JobInfo[]>(`/api/repos/${repoId}/jobs`);
    expect(jobs.status).toBe(200);
    expect(Array.isArray(jobs.body)).toBe(true);
  });

  it('404s on an unknown repository and an unknown api route', async () => {
    const missing = await get<{ error: string }>(`/api/repos/9999`);
    expect(missing.status).toBe(404);
    const summary = await get<{ error: string }>(`/api/metrics/summary${qs({ repo: 9999 })}`);
    expect(summary.status).toBe(404);
    const route = await get<{ error: string }>('/api/not-a-route');
    expect(route.status).toBe(404);
    expect(route.body.error).toBe('unknown api route');
  });
});

describe('metrics endpoints', () => {
  it('GET /api/metrics/summary returns root metrics, top lists, authors and timeline', async () => {
    const { status, body } = await get<SummaryResponse>(`/api/metrics/summary${qs({ repo: repoId })}`);
    expect(status).toBe(200);
    expect(body.repository).toMatchObject({ id: repoId, name: 'fixture-api', sourceType: 'local' });
    expect(body.root).toMatchObject(EXPECTED.root);
    expect(body.commitCount).toBe(EXPECTED.nonMergeCommits);
    expect(body.topChurn[0]).toMatchObject({ path: 'a.txt', churn: EXPECTED.fileA.churn });
    expect(body.topModified.length).toBeGreaterThan(0);
    expect(body.authors).toHaveLength(1); // mailmap merged both identities
    expect(body.authors[0].ownership).toBe(1);
    expect(body.timeline.length).toBeGreaterThan(0);
    expect(body.timeline[0]).toMatchObject({
      label: expect.any(String),
      added: expect.any(Number),
      churn: expect.any(Number),
    });
  });

  it('GET /api/metrics/top supports both orderings', async () => {
    const churn = await get<ObjectMetrics[]>(`/api/metrics/top${qs({ repo: repoId, by: 'churn', kind: 'file', limit: 3 })}`);
    expect(churn.status).toBe(200);
    expect(churn.body.map((r) => r.path)).toEqual(['a.txt', 'dir/d.txt', 'dir/sub/b.txt']);
    const mods = await get<ObjectMetrics[]>(
      `/api/metrics/top${qs({ repo: repoId, by: 'modifications', kind: 'file', limit: 3 })}`,
    );
    expect(mods.status).toBe(200);
    expect(mods.body[0]).toMatchObject({ path: 'a.txt', modifications: EXPECTED.fileA.modifications });
    const dirs = await get<ObjectMetrics[]>(`/api/metrics/top${qs({ repo: repoId, by: 'churn', kind: 'dir', limit: 2 })}`);
    expect(dirs.body.every((r) => r.kind === 'dir')).toBe(true);
  });

  it('GET /api/metrics/object returns file metrics and 404s on unknown paths', async () => {
    const found = await get<MetricsResponse>(`/api/metrics/object${qs({ repo: repoId, path: 'a.txt' })}`);
    expect(found.status).toBe(200);
    expect(found.body.kind).toBe('file');
    expect(found.body.metrics).toMatchObject(EXPECTED.fileA);
    expect(found.body.authors[0]).toMatchObject({ authorName: 'Probe One', churn: EXPECTED.fileA.churn });
    const missing = await get<{ error: string }>(`/api/metrics/object${qs({ repo: repoId, path: 'nope.txt' })}`);
    expect(missing.status).toBe(404);
    // An object that exists but is untouched inside H answers 200 with zeros,
    // so the dashboard shows an empty selection instead of an error banner.
    const zeroed = await get<MetricsResponse>(
      `/api/metrics/object${qs({ repo: repoId, path: 'bin.dat', commits: fixture.hashes.c1 })}`,
    );
    expect(zeroed.status).toBe(200);
    expect(zeroed.body.metrics).toMatchObject({ path: 'bin.dat', kind: 'file', churn: 0, commitCount: 1 });
  });

  it('GET /api/metrics/children lists immediate children with metrics', async () => {
    const { status, body } = await get<ChildrenResponse>(`/api/metrics/children${qs({ repo: repoId })}`);
    expect(status).toBe(200);
    const paths = body.children.map((c) => c.path);
    expect(paths).toContain('a.txt');
    expect(paths).toContain('dir');
    expect(paths).not.toContain('dir/sub');
    const dir = body.children.find((c) => c.path === 'dir')!;
    expect(dir).toMatchObject(EXPECTED.dirDir);
  });

  it('GET /api/metrics/timeline buckets the root by month', async () => {
    const { status, body } = await get<TimelinePoint[]>(`/api/metrics/timeline${qs({ repo: repoId })}`);
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    // All ten fixture commits fall inside September/October 2020.
    expect(body.every((p) => p.churn === p.added + p.removed)).toBe(true);
    expect(body.reduce((sum, p) => sum + p.churn, 0)).toBe(EXPECTED.root.churn);
  });

  it('requires a repository parameter', async () => {
    const { status, body } = await get<{ error: string }>('/api/metrics/summary');
    expect(status).toBe(400);
    expect(body.error).toMatch(/repo/);
  });
});

describe('filter query parameters', () => {
  it('applies an inclusive from bound (H_t)', async () => {
    const { body } = await get<MetricsResponse>(
      `/api/metrics/object${qs({ repo: repoId, path: '', from: fixture.dateOf(5) })}`,
    );
    expect(body.metrics).toMatchObject({ added: 3, removed: 0, commitCount: 4, modifications: 3 });
  });

  it('applies a half-open from/to range (H_i,j) and accepts ISO dates', async () => {
    const numeric = await get<MetricsResponse>(
      `/api/metrics/object${qs({ repo: repoId, path: '', from: fixture.dateOf(2), to: fixture.dateOf(4) })}`,
    );
    expect(numeric.body.metrics).toMatchObject({ added: 1, removed: 3, commitCount: 2 });
    const iso = await get<MetricsResponse>(
      `/api/metrics/object${qs({ repo: repoId, path: '', from: new Date(fixture.dateOf(2) * 1000).toISOString() })}`,
    );
    expect(iso.body.metrics.commitCount).toBe(7); // c3..c7, c9, c10 (c8 is a merge)
  });

  it('applies a manually selected commit list', async () => {
    const commits = `${fixture.hashes.c1},${fixture.hashes.c4}`;
    const { body } = await get<MetricsResponse>(
      `/api/metrics/object${qs({ repo: repoId, path: '', commits })}`,
    );
    expect(body.metrics).toMatchObject({ added: 5, removed: 3, commitCount: 2, modifications: 2 });
  });

  it('applies an author filter', async () => {
    const { body: authors } = await get<AuthorInfo[]>(`/api/repos/${repoId}/authors`);
    const canonical = authors.find((a) => a.canonicalId === a.id)!;
    const { body } = await get<MetricsResponse>(
      `/api/metrics/object${qs({ repo: repoId, path: '', author: canonical.id })}`,
    );
    expect(body.metrics).toMatchObject({ churn: EXPECTED.root.churn, commitCount: EXPECTED.nonMergeCommits });
  });
});

describe('browse endpoints', () => {
  it('GET /api/repos/:id/commits lists commits newest first for the picker', async () => {
    const { status, body } = await get<CommitInfo[]>(`/api/repos/${repoId}/commits?limit=5`);
    expect(status).toBe(200);
    expect(body).toHaveLength(5);
    expect(body[0]).toMatchObject({ subject: 'c10 mailmap', authorName: 'Probe One', isMerge: false });
    expect(body[0].shortHash).toBe(body[0].hash.slice(0, 8));
    const all = await get<CommitInfo[]>(`/api/repos/${repoId}/commits`);
    expect(all.body).toHaveLength(EXPECTED.nonMergeCommits);
    expect(all.body.every((c) => c.isMerge === false)).toBe(true);
  });

  it('GET /api/repos/:id/objects filters by kind and prefix', async () => {
    const dirs = await get<ObjectInfo[]>(`/api/repos/${repoId}/objects?kind=dir`);
    expect(dirs.body.map((o) => o.path)).toEqual(['', 'dir', 'dir/sub']);
    const underDir = await get<ObjectInfo[]>(`/api/repos/${repoId}/objects?prefix=dir/`);
    expect(underDir.body.map((o) => o.path)).toContain('dir/sub');
    expect(underDir.body.every((o) => o.path.startsWith('dir/'))).toBe(true);
  });
});

describe('author endpoints', () => {
  it('GET /api/repos/:id/authors exposes the identity groups', async () => {
    const { status, body } = await get<AuthorInfo[]>(`/api/repos/${repoId}/authors`);
    expect(status).toBe(200);
    expect(body).toHaveLength(2);
    const uno = body.find((a) => a.name === 'Probe Uno')!;
    const one = body.find((a) => a.name === 'Probe One')!;
    expect(uno.canonicalId).toBe(one.id);
    expect(uno.mergeSource).toBe('mailmap');
    expect(one.mergeSource).toBe('identity');
  });

  it('POST /api/repos/:id/authors/merge validates its body and target', async () => {
    const empty = await post<{ error: string }>(`/api/repos/${repoId}/authors/merge`, {});
    expect(empty.status).toBe(400);
    const unknown = await post<{ error: string }>(`/api/repos/${repoId}/authors/merge`, {
      sourceIds: [1],
      targetId: 9999,
    });
    expect(unknown.status).toBe(404);
  });

  it('POST /api/repos/:id/authors/merge regroups identities as manual', async () => {
    const { body: authors } = await get<AuthorInfo[]>(`/api/repos/${repoId}/authors`);
    const uno = authors.find((a) => a.name === 'Probe Uno')!;
    const one = authors.find((a) => a.name === 'Probe One')!;
    const { status, body } = await post<AuthorInfo[]>(`/api/repos/${repoId}/authors/merge`, {
      sourceIds: [uno.id],
      targetId: one.id,
    });
    expect(status).toBe(200);
    expect(body.find((a) => a.id === uno.id)!.mergeSource).toBe('manual');
    expect(body.filter((a) => a.canonicalId === a.id)).toHaveLength(1);
    // Ownership is unchanged: both identities were already merged by .mailmap.
    const { body: rows } = await get<{ ownership: number }[]>(
      `/api/metrics/authors${qs({ repo: repoId, path: '' })}`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].ownership).toBe(1);
  });
});
