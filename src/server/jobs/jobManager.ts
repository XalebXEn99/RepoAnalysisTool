import { query } from '../db/connection';

export interface JobHandle {
  jobId: number;
  update(stage: string, progress: number, message?: string): Promise<void> | void;
}

export async function enqueue(repositoryId: number): Promise<number> {
  return (await query<{ id: number }>('INSERT INTO jobs(repository_id) VALUES ($1) RETURNING id', [repositoryId]))[0].id;
}

export async function claimJob(workerId: string): Promise<{ id: number; repository_id: number } | undefined> {
  // Expired leases may be retried after a worker crash; every retry rebuilds derived data.
  await query(`UPDATE jobs SET status='error',stage='failed',message='worker interrupted too many times',
    updated_at=now() WHERE (status='queued' OR (status='running' AND lease_until<now())) AND attempts>=3`);
  await query(`UPDATE repositories SET status='error',error='worker interrupted too many times'
    WHERE status IN ('pending','ingesting') AND id IN (
      SELECT repository_id FROM jobs WHERE status='error' AND attempts>=3)`);
  return (await query<{ id: number; repository_id: number }>(`UPDATE jobs SET
    status='running',stage='starting',attempts=attempts+1,worker_id=$1,
    lease_until=now()+interval '2 minutes',updated_at=now()
    WHERE id=(SELECT id FROM jobs
      WHERE status='queued' OR (status='running' AND lease_until<now())
      ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING id,repository_id`, [workerId]))[0];
}

export function jobHandle(jobId: number, workerId: string): JobHandle {
  return {
    jobId,
    update: async (stage, progress, message = '') => {
      const rows = await query(`UPDATE jobs SET stage=$1,progress=$2,message=$3,updated_at=now(),
        lease_until=now()+interval '2 minutes' WHERE id=$4 AND worker_id=$5 AND status='running' RETURNING id`,
      [stage, Math.max(0, Math.min(1, progress)), message, jobId, workerId]);
      if (!rows.length) throw new Error('job lease lost');
    },
  };
}
