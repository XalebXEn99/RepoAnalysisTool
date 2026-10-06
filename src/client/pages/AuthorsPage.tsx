import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { num } from '../components/MetricBits';
import type { AuthorInfo, RepositorySummary } from '../../shared/types';

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

  useEffect(() => {
    if (!props.repoId) {
      setAuthors([]);
      return;
    }
    api
      .authors(props.repoId)
      .then(setAuthors)
      .catch((err: Error) => setError(err.message));
  }, [props.repoId]);

  const merge = async () => {
    if (!props.repoId || target === undefined || selected.size === 0) return;
    setError('');
    setNotice('');
    try {
      const next = await api.mergeAuthors(props.repoId, [...selected], target);
      setAuthors(next);
      setSelected(new Set());
      setNotice('authors merged; metrics now use the canonical identities.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <>
      <h1>Authors &amp; merging</h1>
      <section className="panel">
        <div className="row">
          <label className="muted">repository</label>
          <select value={props.repoId ?? ''} onChange={(e) => props.onRepoChange(Number(e.target.value))}>
            <option value="">— select —</option>
            {props.repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <button className="primary" disabled={selected.size === 0 || target === undefined} onClick={merge}>
            merge {selected.size > 0 ? selected.size : ''} into target
          </button>
        </div>
        <p className="muted">
          Identities are pre-merged through the repository&apos;s .mailmap. Tick the rows that belong together,
          choose the target identity with the radio button, then merge.
        </p>
        {error && <p className="error-text">{error}</p>}
        {notice && <p>{notice}</p>}
        {authors.length === 0 ? (
          <p className="muted">No authors yet.</p>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>merge</th>
                <th>target</th>
                <th>name</th>
                <th>email</th>
                <th>canonical</th>
                <th>source</th>
                <th className="num">commits</th>
                <th className="num">churn λ</th>
              </tr>
            </thead>
            <tbody>
              {authors.map((a) => (
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
                  <td>{a.name}</td>
                  <td className="muted">{a.email}</td>
                  <td>{a.canonicalName}</td>
                  <td>
                    <span className="badge">{a.mergeSource}</span>
                  </td>
                  <td className="num">{num(a.commitCount)}</td>
                  <td className="num">{num(a.churn)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
