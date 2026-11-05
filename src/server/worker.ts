import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { query, closeDb } from './db/connection';
import { claimJob, jobHandle } from './jobs/jobManager';
import { ingestRepository } from './ingest/ingestionService';
import { ensureDataDirs, REPOS_DIR, UPLOADS_DIR, MAX_EXTRACT_BYTES } from './config';
import { wakeVersion } from './jobs/wake';

async function diskUsage(directory: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await diskUsage(file);
    else if (entry.isFile()) total += (await fs.stat(file)).size;
  }
  return total;
}

async function main(): Promise<void> {
  ensureDataDirs();
  const workerId = randomUUID();
  let stopping = false;
  let active: AbortController | undefined;
  let version = '';
  let nextScan = 0;
  const stop = () => { stopping = true; active?.abort(new Error('worker shutting down')); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  console.log('[worker] ready');
  while (!stopping) {
    const wake = await wakeVersion();
    if (wake === version && Date.now() < nextScan) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    version = wake;
    await query(`UPDATE repositories SET status='error',error='upload interrupted before queueing'
      WHERE status='pending' AND created_at<now()-interval '1 hour'
      AND NOT EXISTS (SELECT 1 FROM jobs WHERE repository_id=repositories.id)`);
    const job = await claimJob(workerId);
    if (!job) {
      // Local wake-ups keep imports prompt without preventing Neon's idle suspension.
      nextScan = Date.now() + 10 * 60 * 1000;
      continue;
    }
    active = new AbortController();
    const controller = active;
    let monitoring = false;
    const monitor = setInterval(() => {
      if (monitoring) return;
      monitoring = true;
      void (async () => {
        const renewed = await query(`UPDATE jobs SET lease_until=now()+interval '2 minutes',updated_at=now()
          WHERE id=$1 AND worker_id=$2 AND status='running' RETURNING id`, [job.id, workerId]);
        if (!renewed.length) throw new Error('job lease lost');
        if (await diskUsage(path.join(REPOS_DIR, String(job.repository_id))) > MAX_EXTRACT_BYTES) {
          throw new Error('repository exceeds disk quota');
        }
      })().catch((error: unknown) => controller.abort(error)).finally(() => { monitoring = false; });
    }, 10000);
    try {
      await ingestRepository(job.repository_id, jobHandle(job.id, workerId), controller.signal);
      controller.signal.throwIfAborted();
      clearInterval(monitor);
      await query(`UPDATE jobs SET status='done',stage='done',progress=1,message='completed',lease_until=NULL,updated_at=now()
        WHERE id=$1 AND worker_id=$2`, [job.id, workerId]);
      await fs.rm(path.join(UPLOADS_DIR, `repo-${job.repository_id}.zip`), { force: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[worker] job ${job.id} failed`, message);
      if (!stopping) {
        await query(`UPDATE jobs SET status='error',stage='failed',message=$1,lease_until=NULL,updated_at=now()
          WHERE id=$2 AND worker_id=$3`, [message, job.id, workerId]);
        await query(`UPDATE repositories SET status='error',error=$1 WHERE id=$2`, [message, job.repository_id]);
      }
    } finally {
      clearInterval(monitor);
      active = undefined;
      nextScan = 0;
    }
  }
}

void main().catch((error: unknown) => {
  console.error('[worker] stopped unexpectedly', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(closeDb);
