import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { num } from '../components/MetricBits';
import { RatWheelLoader } from '../components/RatWheelLoader';
import type { AuthorInfo, RepositorySummary } from '../../shared/types';

const PAGE_SIZE = 20;

export function AuthorsPage(props: {
  repos: RepositorySummary[];
  repoId: number | undefined;
  onRepoChange: (id: number) => void;
}) {
  const [authors, setAuthors] = useState<AuthorInfo[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [target, setTarget] = useState<number | undefined>(undefined);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [visible, setVisible] = useState(PAGE_SIZE);

  useEffect(() => {
    if (!props.repoId) {
      setAuthors([]);
      return;
    }
    setLoading(true);
    api
      .authors(props.repoId)
      .then(setAuthors)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [props.repoId]);

  const merge = async () => {
    if (!props.repoId || target === undefined || selected.size === 0) return;
    setError('');
    setNotice('');
    try {
      const next = await api.mergeAuthors(props.repoId, [...selected], target);
      setAuthors(next);
      setSelected(new Set());
      setNotice('Subjects merged — metrics now use canonical identities.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const maxChurn = Math.max(...authors.map((a) => a.churn), 1);
  const shown = authors.slice(0, visible);
  const hasMore = authors.length > visible;

  return (
    <>
      <h1>Subjects &amp; Merging</h1>
      <section className="panel">
        <div className="row">
          <label className="field-label" htmlFor="authors-repository">Specimen:</label>
          <select id="authors-repository" value={props.repoId ?? ''} onChange={(e) => props.onRepoChange(Number(e.target.value))}>
            <option value="">— select —</option>
            {props.repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <button className="primary" disabled={selected.size === 0 || target === undefined} onClick={merge}>
            Merge {selected.size > 0 ? `${selected.size} ` : ''}into target
          </button>
        </div>
        <p className="muted text-small">
          Identities are pre-merged through .mailmap. Tick rows to merge, choose a target with the radio button.
        </p>
        {error && <p className="error-text">{error}</p>}
        {notice && <p className="success-text">{notice}</p>}
      </section>

      {loading && <RatWheelLoader />}

      {!loading && authors.length === 0 && props.repoId && (
        <section className="panel"><p className="muted">No subjects found.</p></section>
      )}

      {!loading && authors.length > 0 && (
        <section className="panel">
          <div className="spread" style={{ marginBottom: 12 }}>
            <span className="muted text-small">{authors.length} total subjects</span>
          </div>
          <div className="table-container">
            <table className="grid">
              <thead>
                <tr>
                  <th>Merge</th>
                  <th>Target</th>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Canonical</th>
                  <th>Source</th>
                  <th className="num">Commits</th>
                  <th className="num">Churn</th>
                  <th style={{ width: '15%' }}>Activity</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(a.id)}
                        onChange={() =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (next.has(a.id)) next.delete(a.id);
                            else next.add(a.id);
                            return next;
                          })
                        }
                      />
                    </td>
                    <td>
                      <input type="radio" name="merge-target" checked={target === a.id} onChange={() => setTarget(a.id)} />
                    </td>
                    <td className="text-medium">{a.name}</td>
                    <td className="muted text-small">{a.email}</td>
                    <td>{a.canonicalName}</td>
                    <td><span className="badge">{a.mergeSource}</span></td>
                    <td className="num">{num(a.commitCount)}</td>
                    <td className="num">{num(a.churn)}</td>
                    <td>
                      <div className="water-bottle-bar">
                        <div className="bottle-track">
                          <div className="bottle-fill" style={{ width: `${(a.churn / maxChurn) * 100}%` }} />
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {hasMore && (
            <div className="load-more-row">
              <button onClick={() => setVisible((v) => v + PAGE_SIZE)}>
                Load more ({authors.length - visible} remaining)
              </button>
            </div>
          )}
        </section>
      )}
    </>
  );
}
