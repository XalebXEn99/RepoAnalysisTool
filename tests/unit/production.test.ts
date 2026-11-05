import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setupTestDatabase, closeTestDatabase } from '../helpers/database';
import { query } from '../../src/server/db/connection';
import { enqueue, claimJob, jobHandle } from '../../src/server/jobs/jobManager';
import { streamGitLog, parseGitLog, runGitLog } from '../../src/server/ingest/gitLogParser';
import { validateRemoteUrl, extractRepositoryZip } from '../../src/server/ingest/gitSource';
import { cleanupScratch, createFixtureRepo, scratchDir } from '../helpers/fixture';
import { ingestRepository } from '../../src/server/ingest/ingestionService';
import { zipSync } from 'fflate';

beforeAll(setupTestDatabase);
afterAll(async () => { await closeTestDatabase(); cleanupScratch(); });

describe('durable job claims', () => {
  it('claims once, recovers expired work, and rejects a stale worker', async () => {
    const [{ id }] = await query<{ id: number }>(`INSERT INTO repositories(name,source_type) VALUES ('jobs','local') RETURNING id`);
    const jobId = await enqueue(id);
    expect((await claimJob('first'))?.id).toBe(jobId);
    expect(await claimJob('second')).toBeUndefined();
    await jobHandle(jobId, 'first').update('history', 0.4);
    await query(`UPDATE jobs SET lease_until=now()-interval '1 minute' WHERE id=$1`, [jobId]);
    expect((await claimJob('second'))?.id).toBe(jobId);
    await expect(jobHandle(jobId, 'first').update('done', 1)).rejects.toThrow('lease lost');
    await query(`UPDATE jobs SET attempts=3,lease_until=now()-interval '1 minute' WHERE id=$1`, [jobId]);
    expect(await claimJob('third')).toBeUndefined();
    expect((await query('SELECT status FROM jobs WHERE id=$1', [jobId]))[0].status).toBe('error');
    expect((await query('SELECT status FROM repositories WHERE id=$1', [id]))[0].status).toBe('error');
  });
});

describe('bounded history ingestion', () => {
  it('streaming agrees exactly with the existing byte parser', async () => {
    const fixture = createFixtureRepo();
    const streamed = [];
    for await (const commit of streamGitLog(fixture.dir)) streamed.push(commit);
    expect(streamed).toEqual(parseGitLog(runGitLog(fixture.dir)));
  });

  it('handles empty commits spanning multiple stream records and batch boundaries', async () => {
    const dir = scratchDir('many-commits');
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    let history = '';
    for (let n = 0; n < 251; n++) {
      const message = `commit ${n}`;
      history += `commit refs/heads/main\nmark :${n + 1}\ncommitter Batch Test <batch@example.invalid> 1600000000 +0000\ndata ${message.length}\n${message}\n${n ? `from :${n}\n` : ''}\n`;
    }
    execFileSync('git', ['-C', dir, 'fast-import', '--quiet'], { input: history });
    const [{ id }] = await query<{ id: number }>(`INSERT INTO repositories(name,source_type,path)
      VALUES ('batch-boundary','local',$1) RETURNING id`, [dir]);
    await ingestRepository(id, { jobId: 0, update: () => undefined });
    expect((await query<{ n: number }>('SELECT COUNT(*) AS n FROM commits WHERE repository_id=$1', [id]))[0].n).toBe(251);
    expect((await query<{ n: number }>('SELECT COUNT(*) AS n FROM changes WHERE repository_id=$1', [id]))[0].n).toBe(0);
    expect((await query('SELECT status FROM repositories WHERE id=$1', [id]))[0].status).toBe('ready');
  }, 120000);
});

describe('import boundaries', () => {
  it('rejects local/network protocols, private destinations and credential-bearing URLs', () => {
    for (const url of ['file:///tmp/repo', 'ssh://github.com/x/y', 'https://127.0.0.1/x',
      'https://github.com:444/x/y', 'https://user:password@github.com/x/y', 'https://github.com/x/y?q=secret']) {
      expect(() => validateRemoteUrl(url)).toThrow();
    }
    expect(validateRemoteUrl('https://github.com/a/b.git')).toBe('https://github.com/a/b.git');
  });

  it('rejects traversal entries before writing outside the extraction root', async () => {
    const dir = scratchDir('unsafe-zip');
    const archive = path.join(dir, 'unsafe.zip');
    await fs.writeFile(archive, zipSync({ '../escaped.txt': new TextEncoder().encode('not allowed') }));
    await expect(extractRepositoryZip(archive, path.join(dir, 'extracted'))).rejects.toThrow();
    await expect(fs.stat(path.join(dir, 'escaped.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports an already-aborted history read explicitly', async () => {
    const fixture = createFixtureRepo();
    const controller = new AbortController();
    controller.abort();
    await expect((async () => {
      for await (const _commit of streamGitLog(fixture.dir, controller.signal)) { /* drain */ }
    })()).rejects.toThrow();
  });
});
