import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupScratch, createFixtureRepo, EXPECTED, scratchDir, type Fixture } from '../helpers/fixture';

// Isolated scratch database for this suite; must be set before server modules load.
process.env.RAT_DATA_DIR = scratchDir('rat-db');

const { db } = await import('../../src/server/db/connection');
const { ingestRepository } = await import('../../src/server/ingest/ingestionService');
const engine = await import('../../src/server/metrics/queryEngine');

let fixture: Fixture;
let repoId = 0;

beforeAll(async () => {
  fixture = createFixtureRepo();
  const info = db()
    .prepare(
      `INSERT INTO repositories (name, source_type, source_url, path, status)
       VALUES ('fixture', 'local', NULL, ?, 'pending')`,
    )
    .run(fixture.dir);
  repoId = Number(info.lastInsertRowid);
  await ingestRepository(repoId, { jobId: 0, update: () => undefined });
}, 120000);

afterAll(cleanupScratch);

const filters = (extra: Record<string, unknown> = {}) => ({ repoId, ...extra });

describe('file, directory and repository metrics', () => {
  it('computes repository metrics as directory metrics on the root', () => {
    const root = engine.getObjectMetrics(filters(), '')!;
    expect(root).toMatchObject(EXPECTED.root);
    expect(root.kind).toBe('dir');
    expect(root.commitCount).toBe(EXPECTED.nonMergeCommits);
    // eta = n / |H| and rho = lambda / |H|
    expect(root.modificationFrequency).toBeCloseTo(8 / 9, 10);
    expect(root.churnRate).toBeCloseTo(17 / 9, 10);
  });

  it('computes file metrics', () => {
    expect(engine.getObjectMetrics(filters(), 'a.txt')).toMatchObject(EXPECTED.fileA);
  });

  it('rolls directory metrics up recursively over immediate children', () => {
    expect(engine.getObjectMetrics(filters(), 'dir')).toMatchObject(EXPECTED.dirDir);
    expect(engine.getObjectMetrics(filters(), 'dir/sub')).toMatchObject(EXPECTED.dirSub);
  });

  it('lists immediate children only', () => {
    const paths = engine.listChildren(filters(), '').map((c) => c.path);
    expect(paths).toContain('a.txt');
    expect(paths).toContain('dir');
    expect(paths).toContain('.mailmap');
    expect(paths).not.toContain('dir/sub'); // not immediate
    expect(paths).not.toContain('real.bin'); // binary: not measured
  });

  it('keeps deleted and renamed paths browsable', () => {
    const paths = engine.listChildren(filters(), 'dir').map((c) => c.path);
    expect(paths).toContain('dir/d.txt'); // deleted in c4
    expect(paths).not.toContain('dir/c.txt'); // renamed away, zero own churn... still registered
  });
});

describe('commit set metrics and filters', () => {
  it('filters H_t from a timestamp inclusive', () => {
    const m = engine.getObjectMetrics(filters({ from: fixture.dateOf(5) }), '')!;
    expect(m.added).toBe(3); // c6 + c7 + c10
    expect(m.removed).toBe(0);
    expect(m.commitCount).toBe(4); // c6, c7, c9, c10
    expect(m.modifications).toBe(3); // c9 is binary only
  });

  it('filters H_{i,j} half-open on committer date', () => {
    const m = engine.getObjectMetrics(filters({ from: fixture.dateOf(2), to: fixture.dateOf(4) }), '')!;
    expect(m.added).toBe(1); // c3
    expect(m.removed).toBe(3); // c4
    expect(m.commitCount).toBe(2);
  });

  it('supports a manually selected commit list', () => {
    const m = engine.getObjectMetrics(
      filters({ commitHashes: [fixture.hashes.c1, fixture.hashes.c4] }),
      '',
    )!;
    expect(m.added).toBe(5);
    expect(m.removed).toBe(3);
    expect(m.commitCount).toBe(2);
    expect(m.modifications).toBe(2);
  });

  it('reports modification frequency and churn rate against |H|', () => {
    const m = engine.getObjectMetrics(filters({ commitHashes: [fixture.hashes.c1] }), 'a.txt')!;
    expect(m.modificationFrequency).toBe(1);
    expect(m.churnRate).toBe(3);
  });

  it('zeroes an object that exists but has no changes inside H', () => {
    // bin.dat first appears in c5, so restricting H to c1 leaves it untouched.
    const m = engine.getObjectMetrics(filters({ commitHashes: [fixture.hashes.c1] }), 'bin.dat')!;
    expect(m).toMatchObject({
      path: 'bin.dat',
      kind: 'file',
      added: 0,
      removed: 0,
      growth: 0,
      churn: 0,
      modifications: 0,
      commitCount: 1,
    });
  });

  it('returns null for an object the repository never contained', () => {
    expect(engine.getObjectMetrics(filters(), 'nope.txt')).toBeNull();
  });

  it('ranks top churned files', () => {
    const top = engine.listTop(filters(), 'churn', 'file', 3);
    expect(top[0]).toMatchObject({ path: 'a.txt', churn: 8 });
  });
});

describe('author metrics and mailmap merging', () => {
  it('merges identities through .mailmap', () => {
    const authors = engine.listAuthors(repoId);
    const canonical = authors.filter((a) => a.canonicalId === a.id);
    expect(canonical).toHaveLength(1);
    expect(canonical[0].name).toBe('Probe One');
    expect(authors).toHaveLength(2); // raw identities remain, grouped
    expect(authors.every((a) => a.mergeSource !== 'identity' || a.email === 'one@x.dev')).toBe(true);
  });

  it('attributes all churn to the canonical author (omega = 1)', () => {
    const rows = engine.listAuthorsForObject(filters(), '');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ authorName: 'Probe One', churn: 17, modifications: 8 });
    expect(rows[0].ownership).toBe(1);
  });

  it('author-filtered metrics equal the unfiltered ones once merged', () => {
    const canonical = engine.listAuthors(repoId).find((a) => a.canonicalId === a.id)!;
    const m = engine.getObjectMetrics(filters({ authorId: canonical.id }), '')!;
    expect(m.churn).toBe(17);
    expect(m.commitCount).toBe(9);
  });

  it('manual merge regroups identities', () => {
    // Simulate the route's merge statement on a second identity pair.
    db()
      .prepare(`INSERT INTO authors (repository_id, name, email, canonical_id, merge_source)
                VALUES (?, 'Stray', 'stray@x.dev', 0, 'identity')`)
      .run(repoId);
    const stray = db()
      .prepare('SELECT id FROM authors WHERE repository_id = ? AND email = ?')
      .get(repoId, 'stray@x.dev') as { id: number };
    db().prepare('UPDATE authors SET canonical_id = ? WHERE id = ?').run(stray.id, stray.id);
    const target = engine.listAuthors(repoId).find((a) => a.name === 'Probe One')!;
    db()
      .prepare(`UPDATE authors SET canonical_id = ?, merge_source = 'manual' WHERE repository_id = ? AND id = ?`)
      .run(target.canonicalId, repoId, stray.id);
    const canonical = engine.listAuthors(repoId).filter((a) => a.canonicalId === a.id);
    expect(canonical).toHaveLength(1);
    expect(canonical[0].name).toBe('Probe One');
  });
});
