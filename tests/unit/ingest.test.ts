import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupScratch, createFixtureRepo, EXPECTED, scratchDir, type Fixture } from '../helpers/fixture';

// Isolated scratch database for this suite; must be set before server modules load.
process.env.RAT_DATA_DIR = scratchDir('rat-ingest-db');

const { db } = await import('../../src/server/db/connection');
const { ingestRepository } = await import('../../src/server/ingest/ingestionService');
const engine = await import('../../src/server/metrics/queryEngine');
const { formatIdent, parseIdent, resolveMailmap } = await import('../../src/server/ingest/mailmap');
const { headCommit, listAuthorIdents } = await import('../../src/server/ingest/gitSource');

interface Stage {
  stage: string;
  progress: number;
}

let fixture: Fixture;
let repoId = 0;
const stages: Stage[] = [];

const recordingHandle = {
  jobId: 0,
  update: (stage: string, progress: number) => stages.push({ stage, progress }),
};
const silentHandle = { jobId: 0, update: () => undefined };

function insertRepo(name: string, sourceType: string, sourceUrl: string | null, repoPath: string): number {
  const info = db()
    .prepare(
      `INSERT INTO repositories (name, source_type, source_url, path, status)
       VALUES (?, ?, ?, ?, 'pending')`,
    )
    .run(name, sourceType, sourceUrl, repoPath);
  return Number(info.lastInsertRowid);
}

/** All objects of a repository as path -> kind. */
function objectRows(id: number): Array<{ path: string; kind: string }> {
  return db()
    .prepare('SELECT path, kind FROM objects WHERE repository_id = ? ORDER BY path')
    .all(id) as Array<{ path: string; kind: string }>;
}

/** Per-object deltas recorded for one commit, addressed by commit subject. */
function changeRows(id: number, subject: string): Array<{ path: string; added: number; removed: number }> {
  return db()
    .prepare(
      `SELECT o.path AS path, ch.added AS added, ch.removed AS removed
       FROM changes ch
       JOIN objects o  ON o.id = ch.object_id
       JOIN commits c  ON c.id = ch.commit_id
       WHERE c.repository_id = ? AND c.subject = ?
       ORDER BY o.path`,
    )
    .all(id, subject) as Array<{ path: string; added: number; removed: number }>;
}

beforeAll(async () => {
  fixture = createFixtureRepo();
  repoId = insertRepo('fixture-local', 'local', null, fixture.dir);
  await ingestRepository(repoId, recordingHandle);
}, 120000);

afterAll(cleanupScratch);

describe('repository finalisation', () => {
  it('marks the repository ready with head commit and commit count', () => {
    const row = db().prepare('SELECT * FROM repositories WHERE id = ?').get(repoId) as Record<string, unknown>;
    expect(row.status).toBe('ready');
    expect(row.error).toBeNull();
    expect(row.head_commit).toBe(headCommit(fixture.dir));
    expect(row.commit_count).toBe(EXPECTED.nonMergeCommits);
    expect(row.ingested_at).toBeTruthy();
  });

  it('stores only non-merge commits, each with author and committer date', () => {
    const rows = db()
      .prepare(
        `SELECT is_merge, parent_count, author_id, committer_date, hash
         FROM commits WHERE repository_id = ?`,
      )
      .all(repoId) as Array<{
      is_merge: number;
      parent_count: number;
      author_id: number;
      committer_date: number;
      hash: string;
    }>;
    expect(rows).toHaveLength(EXPECTED.nonMergeCommits);
    expect(rows.every((r) => r.is_merge === 0)).toBe(true); // H-bar excludes merges
    expect(rows.every((r) => r.parent_count >= 1)).toBe(true);
    expect(rows.every((r) => r.author_id > 0 && r.committer_date > 0 && r.hash.length === 40)).toBe(true);
    // Committer dates are the fixture's deterministic day offsets.
    const dates = rows.map((r) => r.committer_date).sort((a, b) => a - b);
    expect(dates[0]).toBe(fixture.dateOf(0));
    expect(dates[dates.length - 1]).toBe(fixture.dateOf(9));
  });

  it('reports monotonically increasing progress across pipeline stages', () => {
    const names = stages.map((s) => s.stage);
    expect(names[0]).toBe('prepare');
    expect(names).toContain('authors');
    expect(names).toContain('history');
    expect(names[names.length - 1]).toBe('finalise');
    for (let i = 1; i < stages.length; i += 1) {
      expect(stages[i].progress).toBeGreaterThanOrEqual(stages[i - 1].progress);
    }
    expect(stages[stages.length - 1].progress).toBeGreaterThan(0.9);
  });
});

describe('materialised object rollup', () => {
  it('registers the root, every ancestor directory and leaf files', () => {
    const objects = objectRows(repoId);
    expect(objects).toContainEqual({ path: '', kind: 'dir' }); // repository root (brief §2.2)
    expect(objects).toContainEqual({ path: 'dir', kind: 'dir' });
    expect(objects).toContainEqual({ path: 'dir/sub', kind: 'dir' });
    expect(objects).toContainEqual({ path: 'a.txt', kind: 'file' });
    expect(objects).toContainEqual({ path: 'my file.txt', kind: 'file' }); // spaced path stored raw
  });

  it('keeps deleted and renamed-away paths browsable', () => {
    const paths = objectRows(repoId).map((o) => o.path);
    expect(paths).toContain('dir/d.txt'); // deleted in c4
    expect(paths).toContain('dir/c.txt'); // renamed away in c3
    expect(paths).toContain('dir/sub/b.txt'); // renamed in c2
  });

  it('never registers binary-only paths', () => {
    const paths = objectRows(repoId).map((o) => o.path);
    expect(paths).not.toContain('real.bin'); // binary files are not measured (brief §2)
    expect(paths).toContain('bin.dat'); // ...but textual files named .dat are
  });

  it('writes one delta row for the file and one per ancestor directory', () => {
    // c1 adds a.txt (3 lines) and dir/sub/b.txt (2 lines): 5 additions at the root.
    expect(changeRows(repoId, 'c1 initial')).toEqual([
      { path: '', added: 5, removed: 0 },
      { path: 'a.txt', added: 3, removed: 0 },
      { path: 'dir', added: 2, removed: 0 },
      { path: 'dir/sub', added: 2, removed: 0 },
      { path: 'dir/sub/b.txt', added: 2, removed: 0 },
    ]);
  });

  it('rolls a deletion up as removed lines on the old path', () => {
    expect(changeRows(repoId, 'c4 delete')).toEqual([
      { path: '', added: 0, removed: 3 },
      { path: 'dir', added: 0, removed: 3 },
      { path: 'dir/d.txt', added: 0, removed: 3 },
    ]);
  });

  it('records a pure rename as an object without any delta', () => {
    // c2 edits a.txt (+3/-1) and renames dir/sub/b.txt -> dir/c.txt with no edits.
    expect(changeRows(repoId, 'c2 modify and pure rename')).toEqual([
      { path: '', added: 3, removed: 1 },
      { path: 'a.txt', added: 3, removed: 1 },
    ]);
  });

  it('records no deltas at all for a binary-only commit', () => {
    const commit = db()
      .prepare('SELECT id FROM commits WHERE repository_id = ? AND subject = ?')
      .get(repoId, 'c9 binary') as { id: number } | undefined;
    expect(commit).toBeTruthy();
    const changes = db()
      .prepare('SELECT COUNT(*) AS n FROM changes WHERE commit_id = ?')
      .get(commit!.id) as { n: number };
    expect(changes.n).toBe(0);
  });

  it('aggregates multiple files of one commit into a single root row', () => {
    // c3: dir/c.txt -> dir/d.txt with one added line.
    expect(changeRows(repoId, 'c3 rename with change')).toEqual([
      { path: '', added: 1, removed: 0 },
      { path: 'dir', added: 1, removed: 0 },
      { path: 'dir/d.txt', added: 1, removed: 0 },
    ]);
  });
});

describe('author identities and .mailmap', () => {
  it('resolves mailmap targets through git check-mailmap', () => {
    const idents = listAuthorIdents(fixture.dir);
    expect(idents).toHaveLength(2);
    const map = resolveMailmap(fixture.dir, idents);
    expect(map.get(formatIdent({ name: 'Probe Uno', email: 'uno@x.dev' }))).toEqual({
      name: 'Probe One',
      email: 'one@x.dev',
    });
    // Unmapped identities map to themselves.
    expect(map.get(formatIdent({ name: 'Probe One', email: 'one@x.dev' }))).toEqual({
      name: 'Probe One',
      email: 'one@x.dev',
    });
  });

  it('parses and formats identity lines', () => {
    expect(parseIdent('Probe One <one@x.dev>')).toEqual({ name: 'Probe One', email: 'one@x.dev' });
    expect(parseIdent('  Weird Name  <w@x.dev>  ')).toEqual({ name: 'Weird Name', email: 'w@x.dev' });
    expect(parseIdent('not an identity')).toBeNull();
    expect(formatIdent({ name: 'A', email: 'a@b.c' })).toBe('A <a@b.c>');
  });

  it('groups raw identities under one canonical author row', () => {
    const rows = db()
      .prepare('SELECT id, name, email, canonical_id, merge_source FROM authors WHERE repository_id = ?')
      .all(repoId) as Array<{ id: number; name: string; email: string; canonical_id: number; merge_source: string }>;
    expect(rows).toHaveLength(2); // both raw identities are kept, grouped
    const one = rows.find((r) => r.name === 'Probe One')!;
    const uno = rows.find((r) => r.name === 'Probe Uno')!;
    expect(one.canonical_id).toBe(one.id);
    expect(one.merge_source).toBe('identity');
    expect(uno.canonical_id).toBe(one.id);
    expect(uno.merge_source).toBe('mailmap');
  });

  it('links the side-branch commit to the raw identity it was authored under', () => {
    const row = db()
      .prepare(
        `SELECT c.subject AS subject, a.email AS email
         FROM commits c JOIN authors a ON a.id = c.author_id
         WHERE c.repository_id = ? AND a.email = 'uno@x.dev'`,
      )
      .all(repoId) as Array<{ subject: string; email: string }>;
    expect(row.map((r) => r.subject)).toEqual(['c7 side branch by uno']);
  });
});

describe('zip ingestion', () => {
  it('extracts an uploaded zip, locates the repository root and ingests it', async () => {
    const zipPath = path.join(scratchDir('zips'), 'fixture.zip');
    execFileSync('zip', ['-r', '-q', '-y', zipPath, '.'], { cwd: fixture.dir });
    const extractDir = scratchDir('zip-extract');
    const id = insertRepo('fixture-zip', 'zip', zipPath, extractDir);

    await ingestRepository(id, silentHandle);

    const row = db().prepare('SELECT * FROM repositories WHERE id = ?').get(id) as Record<string, unknown>;
    expect(row.status).toBe('ready');
    expect(row.commit_count).toBe(EXPECTED.nonMergeCommits);
    expect(row.path).toBe(extractDir); // .git sits at the top level of this zip
    expect(row.head_commit).toBe(headCommit(fixture.dir));
    expect(fs.existsSync(zipPath)).toBe(false); // the upload is consumed
    // Identical history must produce identical metrics to the local ingest.
    expect(engine.getObjectMetrics({ repoId: id }, '')).toMatchObject(EXPECTED.root);
    expect(objectRows(id)).toEqual(objectRows(repoId));
  }, 120000);

  it('finds the repository root when the zip wraps it in a folder', async () => {
    const zipPath = path.join(scratchDir('zips'), 'wrapped.zip');
    // Zip the fixture directory itself, so entries live under one top-level folder.
    execFileSync('zip', ['-r', '-q', '-y', zipPath, path.basename(fixture.dir)], {
      cwd: path.dirname(fixture.dir),
    });
    const extractDir = scratchDir('zip-wrapped');
    const id = insertRepo('fixture-wrapped', 'zip', zipPath, extractDir);

    await ingestRepository(id, silentHandle);

    const row = db().prepare('SELECT * FROM repositories WHERE id = ?').get(id) as Record<string, unknown>;
    expect(row.status).toBe('ready');
    expect(row.path).toBe(path.join(extractDir, path.basename(fixture.dir)));
    expect(row.commit_count).toBe(EXPECTED.nonMergeCommits);
  }, 120000);

  it('rejects a zip that ships no .git directory', async () => {
    const plain = scratchDir('plain');
    fs.writeFileSync(path.join(plain, 'readme.txt'), 'no repository here\n');
    const zipPath = path.join(scratchDir('zips'), 'plain.zip');
    execFileSync('zip', ['-r', '-q', zipPath, '.'], { cwd: plain });
    const id = insertRepo('plain', 'zip', zipPath, scratchDir('zip-plain'));

    await expect(ingestRepository(id, silentHandle)).rejects.toThrow(/\.git/);
  }, 120000);
});
