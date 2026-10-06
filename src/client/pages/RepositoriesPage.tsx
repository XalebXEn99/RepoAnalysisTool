import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { num } from '../components/MetricBits';
import type { JobInfo, RepositorySummary } from '../../shared/types';

export function RepositoriesPage(props: {
  repos: RepositorySummary[];
  onRefresh: () => void;
  onAdd: () => void;
  onSelect: (id: number) => void;
}) {
  const [jobs, setJobs] = useState<Record<number, JobInfo>>({});
  const [error, setError] = useState('');

  const active = props.repos.filter((r) => r.status === 'ingesting' || r.status === 'pending');
  useEffect(() => {
    if (active.length === 0) return;
    let cancelled = false;
    const tick = () => {
      Promise.all(active.map((r) => api.jobs(r.id).then((list) => [r.id, list[0]] as const)))
        .then((entries) => {
          if (cancelled) return;
          const next: Record<number, JobInfo> = {};
          for (const [id, job] of entries) if (job) next[id] = job;
          setJobs(next);
        })
        .catch(() => undefined);
    };
    tick();
    const timer = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.repos.map((r) => `${r.id}:${r.status}`).join(',')]);

  const remove = async (id: number) => {
    if (!window.confirm('Delete this repository and all of its indexed metrics?')) return;
    try {
      await api.deleteRepo(id);
      props.onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <>
      <div className="spread">
        <h1>Repositories</h1>
        <button className="primary" onClick={props.onAdd}>
          add repository
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
      <section className="panel">
        {props.repos.length === 0 ? (
          <p className="muted">Nothing ingested yet.</p>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>name</th>
                <th>source</th>
                <th>status</th>
                <th className="num">commits</th>
                <th>head</th>
                <th>progress</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {props.repos.map((r) => (
                <tr key={r.id}>
                  <td>
                    <button className="secondary" style={{ border: 0, padding: 0, background: 'none', color: 'var(--accent)' }} onClick={() => props.onSelect(r.id)}>
                      {r.name}
                    </button>
                  </td>
                  <td className="muted">{r.sourceType === 'zip' ? 'zip upload' : r.sourceUrl}</td>
                  <td>
                    <span className={`badge ${r.status}`}>{r.status}</span>
                    {r.error ? <div className="error-text">{r.error}</div> : null}
                  </td>
                  <td className="num">{num(r.commitCount)}</td>
                  <td className="muted">{r.headCommit?.slice(0, 8) ?? '—'}</td>
                  <td>
                    {jobs[r.id] ? (
                      <>
                        <div className="progress">
                          <div style={{ width: `${Math.round(jobs[r.id].progress * 100)}%` }} />
                        </div>
                        <span className="muted">
                          {jobs[r.id].stage}: {jobs[r.id].message}
                        </span>
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    <button className="danger" onClick={() => remove(r.id)}>
                      delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
