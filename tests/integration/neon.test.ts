import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtureRepo, cleanupScratch, EXPECTED, scratchDir } from '../helpers/fixture';
import { buildZip } from '../helpers/zip';

// Only point this at a disposable Neon branch: the test deliberately creates data.
describe.runIf(!!process.env.RAT_NEON_TEST_URL)('real PostgreSQL anonymous integration', () => {
  let server: Server;
  let base = '';
  let repositoryId: number;
  let close: () => Promise<void>;
  const origin = 'http://localhost:5173';

  beforeAll(async () => {
    const testUrl = process.env.RAT_NEON_TEST_URL;
    if (!testUrl || new URL(testUrl).hostname.includes('-pooler')) {
      throw new Error('RAT_NEON_TEST_URL must be a direct URL for a disposable database');
    }
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_URL_UNPOOLED = testUrl;
    process.env.RAT_APP_ORIGIN = origin;
    process.env.RAT_DATA_DIR = scratchDir('neon-public-integration');
    const { migrate } = await import('../../src/server/db/migrate');
    const { closeDb } = await import('../../src/server/db/connection');
    close = closeDb;
    await migrate();
    await migrate();
    const { ensureDataDirs } = await import('../../src/server/config');
    ensureDataDirs();
    const { createApp } = await import('../../src/server/app');
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 120000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await close?.();
    cleanupScratch();
  });

  it('accepts anonymous URL imports but rejects cross-site submissions', async () => {
    const response = await fetch(`${base}/api/repos/clone`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ url: 'https://github.com/DaveGamble/cJSON.git' }),
    });
    expect(response.status).toBe(202);
    const queued = await response.json() as { repositoryId: number; jobId: number };
    const { query } = await import('../../src/server/db/connection');
    expect((await query('SELECT status FROM jobs WHERE id=$1', [queued.jobId]))[0].status).toBe('queued');
    await query('DELETE FROM repositories WHERE id=$1', [queued.repositoryId]);
    const denied = await fetch(`${base}/api/repos/clone`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://untrusted.invalid' },
      body: JSON.stringify({ url: 'https://github.com/DaveGamble/cJSON.git' }),
    });
    expect(denied.status).toBe(403);
  });

  it('uploads anonymous Git history, claims its durable job and serves exact metrics', async () => {
    const fixture = createFixtureRepo();
    const archive = path.join(scratchDir('neon-zip'), 'fixture.zip');
    buildZip(fixture.dir, archive, 'fixture');
    const response = await fetch(`${base}/api/repos/upload`, {
      method: 'POST', headers: { 'x-filename': 'fixture.zip', origin },
      body: await fs.readFile(archive),
    });
    expect(response.status).toBe(202);
    const submitted = await response.json() as { repositoryId: number; jobId: number };
    repositoryId = submitted.repositoryId;
    const { claimJob, jobHandle } = await import('../../src/server/jobs/jobManager');
    expect((await claimJob('neon-validation'))?.id).toBe(submitted.jobId);
    const { ingestRepository } = await import('../../src/server/ingest/ingestionService');
    await ingestRepository(repositoryId, jobHandle(submitted.jobId, 'neon-validation'));
    const { query } = await import('../../src/server/db/connection');
    await query(`UPDATE jobs SET status='done',stage='done',progress=1,lease_until=NULL WHERE id=$1`, [submitted.jobId]);
    const summary = await fetch(`${base}/api/metrics/summary?repo=${repositoryId}`);
    expect(summary.status).toBe(200);
    expect((await summary.json()).root).toMatchObject(EXPECTED.root);
  }, 120000);

  it('recovers expired leases and rejects stale workers', async () => {
    const { query } = await import('../../src/server/db/connection');
    const { enqueue, claimJob, jobHandle } = await import('../../src/server/jobs/jobManager');
    const jobId = await enqueue(repositoryId);
    expect((await claimJob('validation-worker'))?.id).toBe(jobId);
    await jobHandle(jobId, 'validation-worker').update('history', 0.5);
    expect(await claimJob('other-worker')).toBeUndefined();
    await query(`UPDATE jobs SET lease_until=now()-interval '1 minute' WHERE id=$1`, [jobId]);
    expect((await claimJob('recovery-worker'))?.id).toBe(jobId);
    await expect(jobHandle(jobId, 'validation-worker').update('history', 0.7)).rejects.toThrow('lease lost');
  }, 120000);
});
