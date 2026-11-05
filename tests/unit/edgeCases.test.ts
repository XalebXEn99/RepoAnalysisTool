import { execFileSync } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupDatabase, cleanupDatabase } from '../helpers/database';
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
const { REPOS_DIR, UPLOADS_DIR } = await import('../../src/server/config');
const { query } = await import('../../src/server/db/connection');
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
async function insertRepo(name: string, dir: string): Promise<number> {
    const [info] = await query<{
        id: number;
    }>(`INSERT INTO repositories (name, source_type, source_url, path, status)
       VALUES ($1, 'local', NULL, $2, 'pending') RETURNING id`, [name, dir]);
    return info.id;
}
async function ingest(name: string, dir: string): Promise<number> {
    const id = (await insertRepo(name, dir));
    await ingestRepository(id, { jobId: 0, update: () => undefined });
    return id;
}
type RowCounts = {
    authors: number;
    commits: number;
    objects: number;
    changes: number;
    jobs: number;
};
async function counts(repoId: number): Promise<RowCounts> {
    return (await query<RowCounts>(`SELECT (SELECT COUNT(*) FROM authors  WHERE repository_id = $1) AS authors,
              (SELECT COUNT(*) FROM commits  WHERE repository_id = $2) AS commits,
              (SELECT COUNT(*) FROM objects  WHERE repository_id = $3) AS objects,
              (SELECT COUNT(*) FROM changes  WHERE repository_id = $4) AS changes,
              (SELECT COUNT(*) FROM jobs     WHERE repository_id = $5) AS jobs`, [repoId, repoId, repoId, repoId, repoId]))[0];
}
beforeAll(async () => {
    await setupDatabase();
    ensureDataDirs();
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120000);
afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await cleanupDatabase();
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
    it('keeps every commit, including the file-less one', async () => {
        expect(commits.map((c) => c.subject)).toEqual(['f3 real', 'f2 no files', 'f1 real']);
        expect(commits.map((c) => c.files.length)).toEqual([1, 0, 1]);
    });
    it('parses sane headers for all of them', async () => {
        for (const c of commits) {
            expect(c.hash).toMatch(/^[0-9a-f]{40}$/);
            expect(c.authorName).toBe('Edge Probe');
            expect(c.authorEmail).toBe('edge@x.dev');
            expect(c.committerDate).toBe(1600000000);
        }
        expect(commits[0].parents).toHaveLength(1);
        expect(commits[2].parents).toHaveLength(0); // f1 is the root commit
    });
    it('does not attribute the neighbouring deltas to the file-less commit', async () => {
        expect(commits[1].files).toEqual([]);
        expect(commits[2].files).toEqual([
            expect.objectContaining({ path: 'f.txt', added: 1, removed: 0, binary: false }),
        ]);
    });
    it('handles a history that ends with a file-less commit', async () => {
        const d = initRepo('fileless-tail');
        commit(d, 't1 no files');
        commit(d, 't2 no files');
        const parsed = parseGitLog(runGitLog(d));
        expect(parsed.map((c) => c.subject)).toEqual(['t2 no files', 't1 no files']);
        expect(parsed.every((c) => c.files.length === 0)).toBe(true);
    });
    it('handles an empty commit message', async () => {
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
    it('ingests cleanly instead of failing on an unborn HEAD', async () => {
        const row = (await query(`SELECT * FROM repositories WHERE id = $1`, [repoId]))[0] as Record<string, unknown>;
        expect(row.status).toBe('ready');
        expect(row.error).toBeNull();
        expect(row.commit_count).toBe(0);
        expect(row.head_commit).toBeNull();
    });
    it('registers only the root object and no changes', async () => {
        expect((await counts(repoId))).toMatchObject({ commits: 0, changes: 0, authors: 0, objects: 1 });
        expect((await engine.listObjects(repoId, undefined, ''))).toEqual([{ id: expect.any(Number), path: '', kind: 'dir' }]);
    });
    it('reports zeroed metrics without NaN or division by zero', async () => {
        const root = (await engine.getObjectMetrics({ repoId }, ''))!;
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
        expect((await engine.listChildren({ repoId }, ''))).toEqual([]);
        expect((await engine.getTimeline({ repoId }, ''))).toEqual([]);
        expect((await engine.listTop({ repoId }, 'churn', 'file', 10))).toEqual([]);
        expect((await engine.listAuthorsForObject({ repoId }, ''))).toEqual([]);
        expect((await engine.listAuthors(repoId))).toEqual([]);
        expect((await engine.listCommits({ repoId }))).toEqual([]);
        expect((await engine.commitSetSize({ repoId }))).toBe(0);
    });
    it('serves the summary route with zeros', async () => {
        const res = await fetch(`${base}/api/metrics/summary?repo=${repoId}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            root: {
                churn: number;
                commitCount: number;
            };
            topChurn: unknown[];
        };
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
        const row = (await query(`SELECT status, commit_count FROM repositories WHERE id = $1`, [repoId]))[0] as Record<string, unknown>;
        expect(row).toMatchObject({ status: 'ready', commit_count: 1 });
        expect((await counts(repoId))).toMatchObject({ commits: 1, changes: 0, objects: 1, authors: 1 });
        expect((await engine.getObjectMetrics({ repoId }, ''))).toMatchObject({ churn: 0, modifications: 0, commitCount: 1 });
    });
    it('counts file-less commits in |H| without inventing changes', async () => {
        const dir = initRepo('only-empty');
        commit(dir, 'e1');
        commit(dir, 'e2');
        const repoId = await ingest('only-empty', dir);
        expect((await counts(repoId))).toMatchObject({ commits: 2, changes: 0, objects: 1, authors: 1 });
        // |H| = 2 even though nothing was measured, so eta and rho stay 0, not NaN.
        expect((await engine.getObjectMetrics({ repoId }, ''))).toMatchObject({
            modifications: 0,
            modificationFrequency: 0,
            churnRate: 0,
            commitCount: 2,
        });
        expect((await engine.listCommits({ repoId })).map((c) => c.subject)).toEqual(['e2', 'e1']);
    });
});
describe('awkward paths', () => {
    const dir = initRepo('awkward');
    let repoId = 0;
    const names = ['a\tb.txt', 'ünïcødé-ファイル.txt', '"quoted".txt', 'sp ace.txt', "semi;colon'tick.txt"];
    const deep = 'l1/l2/l3/l4/l5/l6/l7/l8/deep.txt';
    beforeAll(async () => {
        fs.mkdirSync(path.dirname(path.join(dir, deep)), { recursive: true });
        fs.writeFileSync(path.join(dir, deep), 'deep\n');
        git(dir, ['add', '-A']);
        const tree = git(dir, ['write-tree']).trim();
        const entries = execFileSync('git', ['-C', dir, 'ls-tree', '-z', tree]);
        const blobs = names.map((name) => {
            const hash = execFileSync('git', ['-C', dir, 'hash-object', '-w', '--stdin'], {
                input: `${name.replace(/\t/g, ' ')}\n`,
            }).toString().trim();
            return Buffer.from(`100644 blob ${hash}\t${name}\0`);
        });
        // Write the tree directly: Windows cannot materialize tabs or quotes as filenames.
        const root = execFileSync('git', ['-C', dir, 'mktree', '-z'], {
            input: Buffer.concat([entries, ...blobs]),
        }).toString().trim();
        const hash = execFileSync('git', ['-C', dir, 'commit-tree', root, '-m', 'a1 awkward paths'], {
            env: { ...process.env, ...AUTH },
        }).toString().trim();
        git(dir, ['update-ref', 'refs/heads/main', hash]);
        repoId = await ingest('awkward', dir);
    }, 120000);
    it('stores tabs, unicode, quotes and spaces verbatim', async () => {
        const paths = (await engine.listObjects(repoId, 'file', '')).map((o) => o.path);
        for (const name of names)
            expect(paths).toContain(name);
    });
    it('measures each of them independently', async () => {
        for (const name of names) {
            expect((await engine.getObjectMetrics({ repoId }, name))).toMatchObject({
                path: name,
                kind: 'file',
                added: 1,
                removed: 0,
                churn: 1,
                modifications: 1,
            });
        }
    });
    it('rolls a deeply nested file up through every ancestor', async () => {
        expect((await engine.getObjectMetrics({ repoId }, deep))).toMatchObject({ added: 1, churn: 1 });
        const parts = deep.split('/');
        for (let depth = 1; depth < parts.length; depth += 1) {
            const dirPath = parts.slice(0, depth).join('/');
            expect((await engine.getObjectMetrics({ repoId }, dirPath))).toMatchObject({ kind: 'dir', added: 1, churn: 1 });
        }
        // Root sees all six files.
        expect((await engine.getObjectMetrics({ repoId }, ''))).toMatchObject({ added: names.length + 1, churn: names.length + 1 });
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
    it('promotes the object kind so the path stays browsable', async () => {
        const x = (await engine.listObjects(repoId, undefined, 'x')).find((o) => o.path === 'x')!;
        expect(x.kind).toBe('dir');
    });
    it('aggregates both phases under the same path', async () => {
        // c1 adds x as a file (+1); c2 deletes that file (-1) and adds x/y.txt (+2),
        // and the directory rolls the deletion and the new file up into the same path.
        expect((await engine.getObjectMetrics({ repoId }, 'x'))).toMatchObject({
            added: 3,
            removed: 1,
            churn: 4,
            modifications: 2,
        });
        expect((await engine.listChildren({ repoId }, 'x')).map((c) => c.path)).toEqual(['x/y.txt']);
        expect((await engine.getObjectMetrics({ repoId }, ''))).toMatchObject({ added: 3, removed: 1, churn: 4, modifications: 2 });
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
        const before = (await counts(repoId));
        const metricsBefore = (await engine.getObjectMetrics({ repoId }, ''));
        await ingestRepository(repoId, { jobId: 0, update: () => undefined });
        expect((await counts(repoId))).toEqual(before);
        expect((await engine.getObjectMetrics({ repoId }, ''))).toEqual(metricsBefore);
        const hashes = (await query(`SELECT hash, COUNT(*) n FROM commits WHERE repository_id = $1 GROUP BY hash HAVING COUNT(*) > 1`, [repoId]));
        expect(hashes).toEqual([]);
    });
    it('keeps the unique constraint on (repository_id, hash)', async () => {
        const commit = (await query(`SELECT id, hash, author_id FROM commits WHERE repository_id = $1 LIMIT 1`, [repoId]))[0] as {
            id: number;
            hash: string;
            author_id: number;
        };
        await expect(query(`INSERT INTO commits (repository_id, hash, author_id, committer_date, is_merge, parent_count, subject)
           VALUES ($1, $2, $3, 0, 0, 1, 'duplicate')`, [repoId, commit.hash, commit.author_id])).rejects.toThrow(/unique/i);
    });
    it('recovers a repository left half-ingested', async () => {
        // Simulate an interrupted ingest: rows exist but the repository never finished.
        (await query(`UPDATE repositories SET status = 'ingesting', head_commit = NULL, commit_count = 0 WHERE id = $1`, [repoId]));
        (await query(`DELETE FROM changes WHERE repository_id = $1`, [repoId]));
        await ingestRepository(repoId, { jobId: 0, update: () => undefined });
        const row = (await query(`SELECT status, commit_count FROM repositories WHERE id = $1`, [repoId]))[0] as Record<string, unknown>;
        expect(row).toMatchObject({ status: 'ready', commit_count: 2 });
        expect((await engine.getObjectMetrics({ repoId }, ''))).toMatchObject({ added: 2, removed: 0, churn: 2 });
    });
});
describe('deleting a repository', () => {
    it('cascades to authors, commits, objects, changes and jobs', async () => {
        const dir = initRepo('doomed-sql');
        fs.writeFileSync(path.join(dir, 'f.txt'), 'one\n');
        commit(dir, 'd1');
        const repoId = await ingest('doomed-sql', dir);
        (await query(`INSERT INTO jobs (repository_id, stage, progress, message, status) VALUES ($1, 'done', 1, 'x', 'done')`, [repoId]));
        expect((await counts(repoId)).changes).toBeGreaterThan(0);
        (await query(`DELETE FROM repositories WHERE id = $1`, [repoId]));
        expect((await counts(repoId))).toEqual({ authors: 0, commits: 0, objects: 0, changes: 0, jobs: 0 });
        const constraints = await query<{ convalidated: boolean }>(
            `SELECT convalidated FROM pg_constraint WHERE contype = 'f' AND conrelid = 'changes'::regclass`);
        expect(constraints).toHaveLength(3);
        expect(constraints.every((constraint) => constraint.convalidated)).toBe(true);
    });
    it('DELETE /api/repos/:id removes the rows and the working copy', async () => {
        const dir = initRepo('doomed-http');
        fs.writeFileSync(path.join(dir, 'f.txt'), 'one\n');
        commit(dir, 'd1');
        const repoId = await ingest('doomed-http', dir);
        const managedDir = path.join(REPOS_DIR, String(repoId));
        fs.renameSync(dir, managedDir);
        await query('UPDATE repositories SET path=$1 WHERE id=$2', [managedDir, repoId]);
        expect(fs.existsSync(managedDir)).toBe(true);
        const upload = path.join(UPLOADS_DIR, `repo-${repoId}.zip`);
        fs.writeFileSync(upload, 'retained upload');
        const res = await fetch(`${base}/api/repos/${repoId}`, { method: 'DELETE' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        expect((await counts(repoId))).toEqual({ authors: 0, commits: 0, objects: 0, changes: 0, jobs: 0 });
        expect(fs.existsSync(managedDir)).toBe(false); // managed working copy removed from disk
        expect(fs.existsSync(upload)).toBe(false);
        const again = await fetch(`${base}/api/repos/${repoId}`, { method: 'DELETE' });
        expect(again.status).toBe(404);
        const list = await fetch(`${base}/api/repos`);
        const repos = (await list.json()) as Array<{
            id: number;
        }>;
        expect(repos.some((r) => r.id === repoId)).toBe(false);
    });
    it('leaves other repositories untouched', async () => {
        const rows = (await query(`SELECT COUNT(*) n FROM repositories`, []))[0] as {
            n: number;
        };
        expect(rows.n).toBeGreaterThan(0);
        const orphans = (await query(`SELECT (SELECT COUNT(*) FROM commits c WHERE NOT EXISTS (SELECT 1 FROM repositories r WHERE r.id = c.repository_id)) AS commits,
                (SELECT COUNT(*) FROM changes ch WHERE NOT EXISTS (SELECT 1 FROM repositories r WHERE r.id = ch.repository_id)) AS changes`, []))[0] as {
            commits: number;
            changes: number;
        };
        expect(orphans).toEqual({ commits: 0, changes: 0 });
    });
});
describe('database integrity', () => {
    it('has validated foreign key and check constraints', async () => {
        const constraints = await query<{ conname: string }>(
            `SELECT conname FROM pg_constraint WHERE connamespace = 'public'::regnamespace
             AND contype IN ('f', 'c') AND NOT convalidated`);
        expect(constraints).toEqual([]);
    });
    it('enforces foreign keys and nonnegative deltas', async () => {
        await expect(query(
            `INSERT INTO authors (repository_id, name, email) VALUES ($1, 'Orphan', 'orphan@x.dev')`,
            [2147483647],
        )).rejects.toThrow(/foreign key/i);
        await expect(query(
            `INSERT INTO changes (repository_id, commit_id, object_id, added, removed)
             VALUES (2147483647, 2147483647, 2147483647, -1, 0)`,
        )).rejects.toThrow(/check constraint/i);
    });
    it('indexes the hot access paths', async () => {
        const indexes = (await query(`SELECT indexname AS name FROM pg_indexes WHERE schemaname = 'public'`, [])) as Array<{
            name: string;
        }>;
        const names = indexes.map((i) => i.name);
        for (const expected of ['idx_commits_repo_date', 'objects_repository_id_path_key', 'idx_changes_repo_obj']) {
            expect(names).toContain(expected);
        }
    });
});
