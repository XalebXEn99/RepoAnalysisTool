import { execFileSync } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupScratch, scratchDir } from '../helpers/fixture';

/**
 * Database and edge-case suite: pathological repositories (no commits, commits
 * that change no files, binary-only histories, awkward paths, a path that is a
 * file and later a directory), re-ingestion, cascade deletion and integrity.
 */

// Isolated scratch database for this suite; must be set before server modules load.
process.env.RAT_DATA_DIR = scratchDir('rat-edge-db');

const { createApp } = await import('../../src/server/app');
const { ensureDataDirs } = await import('../../src/server/config');
const { db } = await import('../../src/server/db/connection');
const { ingestRepository } = await import('../../src/server/ingest/ingestionService');
const { parseGitLog, runGitLog } = await import('../../src/server/ingest/gitLogParser');
const engine = await import('../../src/server/metrics/queryEngine');

const DATE = '1600000000 +0000';
const AUTH = {
  GIT_AUTHOR_NAME: 'Edge Probe',
  GIT_AUTHOR_EMAIL: 'edge@x.dev',
  GIT_AUTHOR_DATE: DATE,
  GIT_COMMITTER_NAME: 'Edge Probe',
  GIT_COMMITTER_EMAIL: 'edge@x.dev',
  GIT_COMMITTER_DATE: DATE,
};

let server: Server | undefined;
let base = '';

function git(dir: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('git', ['-C', dir, ...args], {
    env: { ...process.env, GIT_PAGER: 'cat', ...AUTH, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
}

function initRepo(name: string): string {
  const dir = scratchDir(name);
  git(dir, ['init', '-q', '-b', 'main', '.']);
  git(dir, ['config', 'user.name', AUTH.GIT_AUTHOR_NAME]);
  git(dir, ['config', 'user.email', AUTH.GIT_AUTHOR_EMAIL]);
  return dir;
}

/** Commits whatever is staged, tolerating an empty index. */
function commit(dir: string, message: string, extra: string[] = []): string {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message, '--allow-empty', ...extra]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

function insertRepo(name: string, dir: string): number {
  const info = db()
    .prepare(
      `INSERT INTO repositories (name, source_type, source_url, path, status)
       VALUES (?, 'local', NULL, ?, 'pending')`,
    )
    .run(name, dir);
  return Number(info.lastInsertRowid);
}

async function ingest(name: string, dir: string): Promise<number> {
  const id = insertRepo(name, dir);
  await ingestRepository(id, { jobId: 0, update: () => undefined });
  return id;
}

interface RowCounts {
  authors: number;
  commits: number;
  objects: number;
  changes: number;
  jobs: number;
}

function counts(repoId: number): RowCounts {
  return db()
    .prepare(
      `SELECT (SELECT COUNT(*) FROM authors  WHERE repository_id = ?) AS authors,
              (SELECT COUNT(*) FROM commits  WHERE repository_id = ?) AS commits,
              (SELECT COUNT(*) FROM objects  WHERE repository_id = ?) AS objects,
              (SELECT COUNT(*) FROM changes  WHERE repository_id = ?) AS changes,
              (SELECT COUNT(*) FROM jobs     WHERE repository_id = ?) AS jobs`,
    )
    .get(repoId, repoId, repoId, repoId, repoId) as RowCounts;
}

beforeAll(async () => {
  ensureDataDirs();
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120000);

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  cleanupScratch();
});

describe('git log framing around commits that change no files', () => {
  // git terminates the pretty header with \n only when numstat output follows;
  // a file-less commit ends with NUL instead, which used to swallow records.
  const dir = initRepo('fileless');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'one\n');
  commit(dir, 'f1 real');
  commit(dir, 'f2 no files');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'one\ntwo\n');
  commit(dir, 'f3 real');
  const commits = parseGitLog(runGitLog(dir));

  it('keeps every commit, including the file-less one', () => {
    expect(commits.map((c) => c.subject)).toEqual(['f3 real', 'f2 no files', 'f1 real']);
    expect(commits.map((c) => c.files.length)).toEqual([1, 0, 1]);
  });

  it('parses sane headers for all of them', () => {
    for (const c of commits) {
      expect(c.hash).toMatch(/^[0-9a-f]{40}$/);
      expect(c.authorName).toBe('Edge Probe');
      expect(c.authorEmail).toBe('edge@x.dev');
      expect(c.committerDate).toBe(1600000000);
    }
    expect(commits[0].parents).toHaveLength(1);
    expect(commits[2].parents).toHaveLength(0); // f1 is the root commit
  });

  it('does not attribute the neighbouring deltas to the file-less commit', () => {
    expect(commits[1].files).toEqual([]);
    expect(commits[2].files).toEqual([
      expect.objectContaining({ path: 'f.txt', added: 1, removed: 0, binary: false }),
    ]);
  });

  it('handles a history that ends with a file-less commit', () => {
    const d = initRepo('fileless-tail');
    commit(d, 't1 no files');
    commit(d, 't2 no files');
    const parsed = parseGitLog(runGitLog(d));
    expect(parsed.map((c) => c.subject)).toEqual(['t2 no files', 't1 no files']);
    expect(parsed.every((c) => c.files.length === 0)).toBe(true);
  });

  it('handles an empty commit message', () => {
    const d = initRepo('empty-message');
    fs.writeFileSync(path.join(d, 'f.txt'), 'x\n');
    commit(d, '', ['--allow-empty-message']);
    commit(d, 'after empty message');
    const parsed = parseGitLog(runGitLog(d));
    expect(parsed.map((c) => c.subject)).toEqual(['after empty message', '']);
    expect(parsed[1].files).toEqual([expect.objectContaining({ path: 'f.txt', added: 1 })]);
  });
});

describe('repository with no commits at all', () => {
  const dir = initRepo('empty-repo');
  let repoId = 0;

  beforeAll(async () => {
    repoId = await ingest('empty-repo', dir);
  }, 120000);

  it('ingests cleanly instead of failing on an unborn HEAD', () => {
    const row = db().prepare('SELECT * FROM repositories WHERE id = ?').get(repoId) as Record<string, unknown>;
    expect(row.status).toBe('ready');
    expect(row.error).toBeNull();
    expect(row.commit_count).toBe(0);
    expect(row.head_commit).toBeNull();
  });

  it('registers only the root object and no changes', () => {
    expect(counts(repoId)).toMatchObject({ commits: 0, changes: 0, authors: 0, objects: 1 });
    expect(engine.listObjects(repoId, undefined, '')).toEqual([{ id: expect.any(Number), path: '', kind: 'dir' }]);
  });

  it('reports zeroed metrics without NaN or division by zero', () => {
    const root = engine.getObjectMetrics({ repoId }, '')!;
    expect(root).toMatchObject({
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
    });
    expect(Number.isNaN(root.modificationFrequency)).toBe(false);
    expect(engine.listChildren({ repoId }, '')).toEqual([]);
    expect(engine.getTimeline({ repoId }, '')).toEqual([]);
    expect(engine.listTop({ repoId }, 'churn', 'file', 10)).toEqual([]);
    expect(engine.listAuthorsForObject({ repoId }, '')).toEqual([]);
    expect(engine.listAuthors(repoId)).toEqual([]);
    expect(engine.listCommits({ repoId })).toEqual([]);
    expect(engine.commitSetSize({ repoId })).toBe(0);
  });

  it('serves the summary route with zeros', async () => {
    const res = await fetch(`${base}/api/metrics/summary?repo=${repoId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { root: { churn: number; commitCount: number }; topChurn: unknown[] };
    expect(body.root).toMatchObject({ churn: 0, commitCount: 0 });
    expect(body.topChurn).toEqual([]);
  });
});

describe('histories that produce no measurable changes', () => {
  it('records a binary-only repository as zero churn', async () => {
    const dir = initRepo('binary-only');
    fs.writeFileSync(path.join(dir, 'real.bin'), Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x00]));
    await commit(dir, 'b1 binary');
    const repoId = await ingest('binary-only', dir);
    const row = db().prepare('SELECT status, commit_count FROM repositories WHERE id = ?').get(repoId) as Record<string, unknown>;
    expect(row).toMatchObject({ status: 'ready', commit_count: 1 });
    expect(counts(repoId)).toMatchObject({ commits: 1, changes: 0, objects: 1, authors: 1 });
    expect(engine.getObjectMetrics({ repoId }, '')).toMatchObject({ churn: 0, modifications: 0, commitCount: 1 });
  });

  it('counts file-less commits in |H| without inventing changes', async () => {
    const dir = initRepo('only-empty');
    commit(dir, 'e1');
    commit(dir, 'e2');
    const repoId = await ingest('only-empty', dir);
    expect(counts(repoId)).toMatchObject({ commits: 2, changes: 0, objects: 1, authors: 1 });
    // |H| = 2 even though nothing was measured, so eta and rho stay 0, not NaN.
    expect(engine.getObjectMetrics({ repoId }, '')).toMatchObject({
      modifications: 0,
      modificationFrequency: 0,
      churnRate: 0,
      commitCount: 2,
    });
    expect(engine.listCommits({ repoId }).map((c) => c.subject)).toEqual(['e2', 'e1']);
  });
});

describe('awkward paths', () => {
  const dir = initRepo('awkward');
  let repoId = 0;
  const names = ['a\tb.txt', 'ünïcødé-ファイル.txt', '"quoted".txt', 'sp ace.txt', "semi;colon'tick.txt"];
  const deep = 'l1/l2/l3/l4/l5/l6/l7/l8/deep.txt';

  beforeAll(async () => {
    for (const name of names) fs.writeFileSync(path.join(dir, name), `${name}\n`);
    fs.mkdirSync(path.dirname(path.join(dir, deep)), { recursive: true });
    fs.writeFileSync(path.join(dir, deep), 'deep\n');
    commit(dir, 'a1 awkward paths');
    repoId = await ingest('awkward', dir);
  }, 120000);

  it('stores tabs, unicode, quotes and spaces verbatim', () => {
    const paths = engine.listObjects(repoId, 'file', '').map((o) => o.path);
    for (const name of names) expect(paths).toContain(name);
  });

  it('measures each of them independently', () => {
    for (const name of names) {
      expect(engine.getObjectMetrics({ repoId }, name)).toMatchObject({
        path: name,
        kind: 'file',
        added: 1,
        removed: 0,
        churn: 1,
        modifications: 1,
      });
    }
  });

  it('rolls a deeply nested file up through every ancestor', () => {
    expect(engine.getObjectMetrics({ repoId }, deep)).toMatchObject({ added: 1, churn: 1 });
    const parts = deep.split('/');
    for (let depth = 1; depth < parts.length; depth += 1) {
      const dirPath = parts.slice(0, depth).join('/');
      expect(engine.getObjectMetrics({ repoId }, dirPath)).toMatchObject({ kind: 'dir', added: 1, churn: 1 });
    }
    // Root sees all six files.
    expect(engine.getObjectMetrics({ repoId }, '')).toMatchObject({ added: names.length + 1, churn: names.length + 1 });
  });
});

describe('a path that is a file and later a directory', () => {
  const dir = initRepo('file-then-dir');
  let repoId = 0;

  beforeAll(async () => {
    fs.writeFileSync(path.join(dir, 'x'), 'one\n');
    commit(dir, 'c1 x is a file');
    fs.rmSync(path.join(dir, 'x'));
    fs.mkdirSync(path.join(dir, 'x'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'x/y.txt'), 'two\nthree\n');
    commit(dir, 'c2 x is a directory');
    repoId = await ingest('file-then-dir', dir);
  }, 120000);

  it('promotes the object kind so the path stays browsable', () => {
    const x = engine.listObjects(repoId, undefined, 'x').find((o) => o.path === 'x')!;
    expect(x.kind).toBe('dir');
  });

  it('aggregates both phases under the same path', () => {
    // c1 adds x as a file (+1); c2 deletes that file (-1) and adds x/y.txt (+2),
    // and the directory rolls the deletion and the new file up into the same path.
    expect(engine.getObjectMetrics({ repoId }, 'x')).toMatchObject({
      added: 3,
      removed: 1,
      churn: 4,
      modifications: 2,
    });
    expect(engine.listChildren({ repoId }, 'x').map((c) => c.path)).toEqual(['x/y.txt']);
    expect(engine.getObjectMetrics({ repoId }, '')).toMatchObject({ added: 3, removed: 1, churn: 4, modifications: 2 });
  });
});

describe('re-ingestion and constraints', () => {
  const dir = initRepo('reingest');
  let repoId = 0;

  beforeAll(async () => {
    fs.writeFileSync(path.join(dir, 'f.txt'), 'one\n');
    commit(dir, 'r1');
    fs.writeFileSync(path.join(dir, 'f.txt'), 'one\ntwo\n');
    commit(dir, 'r2');
    repoId = await ingest('reingest', dir);
  }, 120000);

  it('is idempotent: a second ingest replaces the first without duplicating rows', async () => {
    const before = counts(repoId);
    const metricsBefore = engine.getObjectMetrics({ repoId }, '');
    await ingestRepository(repoId, { jobId: 0, update: () => undefined });
    expect(counts(repoId)).toEqual(before);
    expect(engine.getObjectMetrics({ repoId }, '')).toEqual(metricsBefore);
    const hashes = db()
      .prepare('SELECT hash, COUNT(*) n FROM commits WHERE repository_id = ? GROUP BY hash HAVING n > 1')
      .all(repoId);
    expect(hashes).toEqual([]);
  });

  it('keeps the unique constraint on (repository_id, hash)', () => {
    const commit = db().prepare('SELECT id, hash, author_id FROM commits WHERE repository_id = ? LIMIT 1').get(repoId) as {
      id: number;
      hash: string;
      author_id: number;
    };
    expect(() =>
      db()
        .prepare(
          `INSERT INTO commits (repository_id, hash, author_id, committer_date, is_merge, parent_count, subject)
           VALUES (?, ?, ?, 0, 0, 1, 'duplicate')`,
        )
        .run(repoId, commit.hash, commit.author_id),
    ).toThrow(/UNIQUE/);
  });

  it('recovers a repository left half-ingested', async () => {
    // Simulate an interrupted ingest: rows exist but the repository never finished.
    db().prepare(`UPDATE repositories SET status = 'ingesting', head_commit = NULL, commit_count = 0 WHERE id = ?`).run(repoId);
    db().prepare('DELETE FROM changes WHERE repository_id = ?').run(repoId);
    await ingestRepository(repoId, { jobId: 0, update: () => undefined });
    const row = db().prepare('SELECT status, commit_count FROM repositories WHERE id = ?').get(repoId) as Record<string, unknown>;
    expect(row).toMatchObject({ status: 'ready', commit_count: 2 });
    expect(engine.getObjectMetrics({ repoId }, '')).toMatchObject({ added: 2, removed: 0, churn: 2 });
  });
});

describe('deleting a repository', () => {
  it('cascades to authors, commits, objects, changes and jobs', async () => {
    const dir = initRepo('doomed-sql');
    fs.writeFileSync(path.join(dir, 'f.txt'), 'one\n');
    commit(dir, 'd1');
    const repoId = await ingest('doomed-sql', dir);
    db().prepare(`INSERT INTO jobs (repository_id, stage, progress, message, status) VALUES (?, 'done', 1, 'x', 'done')`).run(repoId);
    expect(counts(repoId).changes).toBeGreaterThan(0);

    db().prepare('DELETE FROM repositories WHERE id = ?').run(repoId);
    expect(counts(repoId)).toEqual({ authors: 0, commits: 0, objects: 0, changes: 0, jobs: 0 });
    expect(db().prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('DELETE /api/repos/:id removes the rows and the working copy', async () => {
    const dir = initRepo('doomed-http');
    fs.writeFileSync(path.join(dir, 'f.txt'), 'one\n');
    commit(dir, 'd1');
    const repoId = await ingest('doomed-http', dir);
    expect(fs.existsSync(dir)).toBe(true);

    const res = await fetch(`${base}/api/repos/${repoId}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(counts(repoId)).toEqual({ authors: 0, commits: 0, objects: 0, changes: 0, jobs: 0 });
    expect(fs.existsSync(dir)).toBe(false); // working copy removed from disk

    const again = await fetch(`${base}/api/repos/${repoId}`, { method: 'DELETE' });
    expect(again.status).toBe(404);
    const list = await fetch(`${base}/api/repos`);
    const repos = (await list.json()) as Array<{ id: number }>;
    expect(repos.some((r) => r.id === repoId)).toBe(false);
  });

  it('leaves other repositories untouched', async () => {
    const rows = db().prepare('SELECT COUNT(*) n FROM repositories').get() as { n: number };
    expect(rows.n).toBeGreaterThan(0);
    const orphans = db()
      .prepare(
        `SELECT (SELECT COUNT(*) FROM commits c WHERE NOT EXISTS (SELECT 1 FROM repositories r WHERE r.id = c.repository_id)) AS commits,
                (SELECT COUNT(*) FROM changes ch WHERE NOT EXISTS (SELECT 1 FROM repositories r WHERE r.id = ch.repository_id)) AS changes`,
      )
      .get() as { commits: number; changes: number };
    expect(orphans).toEqual({ commits: 0, changes: 0 });
  });
});

describe('database integrity', () => {
  it('passes the sqlite integrity and foreign key checks', () => {
    expect(db().prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
    expect(db().prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('runs in WAL mode with foreign keys enforced', () => {
    expect((db().prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    expect((db().prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
  });

  it('indexes the hot access paths', () => {
    const indexes = db()
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'`)
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    for (const expected of ['idx_commits_repo_date', 'idx_objects_repo_path', 'idx_changes_repo_obj']) {
      expect(names).toContain(expected);
    }
  });
});
