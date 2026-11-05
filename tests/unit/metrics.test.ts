import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupScratch, createFixtureRepo, EXPECTED, scratchDir, type Fixture } from '../helpers/fixture';
// Isolated scratch database for this suite; must be set before server modules load.
process.env.RAT_DATA_DIR = scratchDir('rat-db');
import { setupDatabase, cleanupDatabase } from '../helpers/database';
const { query } = await import('../../src/server/db/connection');
const { ingestRepository } = await import('../../src/server/ingest/ingestionService');
const engine = await import('../../src/server/metrics/queryEngine');
let fixture: Fixture;
let repoId = 0;
beforeAll(async () => {
    await setupDatabase();
    fixture = createFixtureRepo();
    const [info] = await query<{
        id: number;
    }>(`INSERT INTO repositories (name, source_type, source_url, path, status)
       VALUES ('fixture', 'local', NULL, $1, 'pending') RETURNING id`, [fixture.dir]);
    repoId = info.id;
    await ingestRepository(repoId, { jobId: 0, update: () => undefined });
}, 120000);
afterAll(async () => { await cleanupDatabase(); cleanupScratch(); });
const filters = (extra: Record<string, unknown> = {}) => ({ repoId, ...extra });
describe('file, directory and repository metrics', () => {
    it('computes repository metrics as directory metrics on the root', async () => {
        const root = (await engine.getObjectMetrics(filters(), ''))!;
        expect(root).toMatchObject(EXPECTED.root);
        expect(root.kind).toBe('dir');
        expect(root.commitCount).toBe(EXPECTED.nonMergeCommits);
        // eta = n / |H| and rho = lambda / |H|
        expect(root.modificationFrequency).toBeCloseTo(8 / 9, 10);
        expect(root.churnRate).toBeCloseTo(17 / 9, 10);
    });
    it('computes file metrics', async () => {
        expect((await engine.getObjectMetrics(filters(), 'a.txt'))).toMatchObject(EXPECTED.fileA);
    });
    it('rolls directory metrics up recursively over immediate children', async () => {
        expect((await engine.getObjectMetrics(filters(), 'dir'))).toMatchObject(EXPECTED.dirDir);
        expect((await engine.getObjectMetrics(filters(), 'dir/sub'))).toMatchObject(EXPECTED.dirSub);
    });
    it('lists immediate children only', async () => {
        const paths = (await engine.listChildren(filters(), '')).map((c) => c.path);
        expect(paths).toContain('a.txt');
        expect(paths).toContain('dir');
        expect(paths).toContain('.mailmap');
        expect(paths).not.toContain('dir/sub'); // not immediate
        expect(paths).not.toContain('real.bin'); // binary: not measured
    });
    it('keeps deleted and renamed paths browsable', async () => {
        const paths = (await engine.listChildren(filters(), 'dir')).map((c) => c.path);
        expect(paths).toContain('dir/d.txt'); // deleted in c4
        expect(paths).not.toContain('dir/c.txt'); // renamed away, zero own churn... still registered
    });
});
describe('commit set metrics and filters', () => {
    it('filters H_t from a timestamp inclusive', async () => {
        const m = (await engine.getObjectMetrics(filters({ from: fixture.dateOf(5) }), ''))!;
        expect(m.added).toBe(3); // c6 + c7 + c10
        expect(m.removed).toBe(0);
        expect(m.commitCount).toBe(4); // c6, c7, c9, c10
        expect(m.modifications).toBe(3); // c9 is binary only
    });
    it('filters H_{i,j} half-open on committer date', async () => {
        const m = (await engine.getObjectMetrics(filters({ from: fixture.dateOf(2), to: fixture.dateOf(4) }), ''))!;
        expect(m.added).toBe(1); // c3
        expect(m.removed).toBe(3); // c4
        expect(m.commitCount).toBe(2);
    });
    it('supports a manually selected commit list', async () => {
        const m = (await engine.getObjectMetrics(filters({ commitHashes: [fixture.hashes.c1, fixture.hashes.c4] }), ''))!;
        expect(m.added).toBe(5);
        expect(m.removed).toBe(3);
        expect(m.commitCount).toBe(2);
        expect(m.modifications).toBe(2);
    });
    it('reports modification frequency and churn rate against |H|', async () => {
        const m = (await engine.getObjectMetrics(filters({ commitHashes: [fixture.hashes.c1] }), 'a.txt'))!;
        expect(m.modificationFrequency).toBe(1);
        expect(m.churnRate).toBe(3);
    });
    it('zeroes an object that exists but has no changes inside H', async () => {
        // bin.dat first appears in c5, so restricting H to c1 leaves it untouched.
        const m = (await engine.getObjectMetrics(filters({ commitHashes: [fixture.hashes.c1] }), 'bin.dat'))!;
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
    it('returns null for an object the repository never contained', async () => {
        expect((await engine.getObjectMetrics(filters(), 'nope.txt'))).toBeNull();
    });
    it('ranks top churned files', async () => {
        const top = (await engine.listTop(filters(), 'churn', 'file', 3));
        expect(top[0]).toMatchObject({ path: 'a.txt', churn: 8 });
    });
});
describe('author metrics and mailmap merging', () => {
    it('merges identities through .mailmap', async () => {
        const authors = (await engine.listAuthors(repoId));
        const canonical = authors.filter((a) => a.canonicalId === a.id);
        expect(canonical).toHaveLength(1);
        expect(canonical[0].name).toBe('Probe One');
        expect(authors).toHaveLength(2); // raw identities remain, grouped
        expect(authors.every((a) => a.mergeSource !== 'identity' || a.email === 'one@x.dev')).toBe(true);
    });
    it('attributes all churn to the canonical author (omega = 1)', async () => {
        const rows = (await engine.listAuthorsForObject(filters(), ''));
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ authorName: 'Probe One', churn: 17, modifications: 8 });
        expect(rows[0].ownership).toBe(1);
    });
    it('author-filtered metrics equal the unfiltered ones once merged', async () => {
        const canonical = (await engine.listAuthors(repoId)).find((a) => a.canonicalId === a.id)!;
        const m = (await engine.getObjectMetrics(filters({ authorId: canonical.id }), ''))!;
        expect(m.churn).toBe(17);
        expect(m.commitCount).toBe(9);
    });
    it('manual merge regroups identities', async () => {
        // Simulate the route's merge statement on a second identity pair.
        (await query(`INSERT INTO authors (repository_id, name, email, canonical_id, merge_source)
                VALUES ($1, 'Stray', 'stray@x.dev', 0, 'identity')`, [repoId]));
        const stray = (await query(`SELECT id FROM authors WHERE repository_id = $1 AND email = $2`, [repoId, 'stray@x.dev']))[0] as {
            id: number;
        };
        (await query(`UPDATE authors SET canonical_id = $1 WHERE id = $2`, [stray.id, stray.id]));
        const target = (await engine.listAuthors(repoId)).find((a) => a.name === 'Probe One')!;
        (await query(`UPDATE authors SET canonical_id = $1, merge_source = 'manual' WHERE repository_id = $2 AND id = $3`, [target.canonicalId, repoId, stray.id]));
        const canonical = (await engine.listAuthors(repoId)).filter((a) => a.canonicalId === a.id);
        expect(canonical).toHaveLength(1);
        expect(canonical[0].name).toBe('Probe One');
    });
});
