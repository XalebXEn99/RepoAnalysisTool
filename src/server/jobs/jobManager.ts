import { db } from '../db/connection';
import type { JobStatus } from '../../shared/types';

export interface JobHandle {
  jobId: number;
  update(stage: string, progress: number, message?: string): void;
}

interface QueuedJob {
  jobId: number;
  repositoryId: number | null;
  task: (handle: JobHandle) => Promise<void>;
}

/**
 * Serial in-process job queue. Ingestion is CPU/IO heavy, so jobs run one at
 * a time and publish progress to the `jobs` table (WAL keeps reads live).
 */
class JobManager {
  private queue: QueuedJob[] = [];
  private pumping = false;

  enqueue(repositoryId: number | null, task: (handle: JobHandle) => Promise<void>): number {
    const info = db()
      .prepare(
        `INSERT INTO jobs (repository_id, stage, progress, message, status)
         VALUES (?, 'queued', 0, 'waiting for worker', 'queued')`,
      )
      .run(repositoryId);
    const jobId = Number(info.lastInsertRowid);
    this.queue.push({ jobId, repositoryId, task });
    void this.pump();
    return jobId;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift()!;
        const handle: JobHandle = {
          jobId: job.jobId,
          update: (stage, progress, message) => this.setProgress(job.jobId, 'running', stage, progress, message),
        };
        this.setProgress(job.jobId, 'running', 'starting', 0, 'starting');
        try {
          await job.task(handle);
          this.setProgress(job.jobId, 'done', 'done', 1, 'completed');
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.setProgress(job.jobId, 'error', 'failed', 0, message);
          if (job.repositoryId !== null) {
            db()
              .prepare(`UPDATE repositories SET status = 'error', error = ? WHERE id = ?`)
              .run(message, job.repositoryId);
          }
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private setProgress(jobId: number, status: JobStatus, stage: string, progress: number, message?: string): void {
    db()
      .prepare(
        `UPDATE jobs SET status = ?, stage = ?, progress = ?, message = ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(status, stage, Math.max(0, Math.min(1, progress)), message ?? '', jobId);
  }
}

export const jobManager = new JobManager();
