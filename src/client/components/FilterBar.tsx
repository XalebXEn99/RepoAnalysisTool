import { useEffect, useState } from 'react';
import { api, query } from '../lib/api';
import type { AuthorInfo, CommitInfo } from '../../shared/types';

/** Client-side filter model mirroring the brief's four filter dimensions. */
export interface UiFilters {
  authorId?: number;
  path: string;
  from: string; // yyyy-mm-dd inclusive
  to: string; // yyyy-mm-dd inclusive
  commits: string[]; // manual commit-set selection
}

export const emptyFilters: UiFilters = { path: '', from: '', to: '', commits: [] };

export function filtersToQuery(repoId: number, f: UiFilters): string {
  const from = f.from ? Math.floor(Date.parse(`${f.from}T00:00:00Z`) / 1000) : undefined;
  // H_{i,j} is [i, j): include the whole "to" day.
  const to = f.to ? Math.floor(Date.parse(`${f.to}T00:00:00Z`) / 1000) + 86400 : undefined;
  return query({
    repo: repoId,
    author: f.authorId,
    path: f.path,
    from,
    to,
    commits: f.commits.length > 0 ? f.commits.join(',') : undefined,
  });
}

function CommitPicker(props: { repoId: number; selected: string[]; onApply: (hashes: string[]) => void; onClose: () => void }) {
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set(props.selected));
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .commits(props.repoId, 300)
      .then(setCommits)
      .catch((err: Error) => setError(err.message));
  }, [props.repoId]);

  const toggle = (hash: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
  };

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="spread">
          <h2>Select Commits</h2>
          <button className="secondary" onClick={props.onClose}>
            ✕ close
          </button>
        </div>
        {error && <p className="error-text">{error}</p>}
        <p className="muted">Most recent 300 non-merge commits. Leave empty to use the whole history / date range.</p>
        <div className="table-container" style={{ maxHeight: '45vh' }}>
          <table className="grid">
            <thead>
              <tr>
                <th></th>
                <th>Commit</th>
                <th>Author</th>
                <th>Date</th>
                <th>Subject</th>
              </tr>
            </thead>
            <tbody>
              {commits.map((c) => (
                <tr key={c.hash} className="clickable" onClick={() => toggle(c.hash)}>
                  <td>
                    <input type="checkbox" checked={picked.has(c.hash)} readOnly />
                  </td>
                  <td><code>{c.shortHash}</code></td>
                  <td>{c.authorName}</td>
                  <td>{new Date(c.committerDate * 1000).toISOString().slice(0, 10)}</td>
                  <td>{c.subject}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          <button className="primary" onClick={() => props.onApply([...picked])}>
            Apply {picked.size > 0 ? `(${picked.size} selected)` : ''}
          </button>
          <button className="secondary" onClick={() => props.onApply([])}>
            Clear selection
          </button>
        </div>
      </div>
    </div>
  );
}

export function FilterBar(props: {
  repoId: number | undefined;
  authors: AuthorInfo[];
  filters: UiFilters;
  onFiltersChange: (filters: UiFilters) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const f = props.filters;
  const set = (patch: Partial<UiFilters>) => props.onFiltersChange({ ...f, ...patch });
  const hasFilters = f.authorId || f.path || f.from || f.to || f.commits.length > 0;

  return (
    <section className="panel" style={{ padding: 0, overflow: 'hidden' }}>
      <div className="filterbar">
        <label>
          Subject (Author)
          <select value={f.authorId ?? ''} onChange={(e) => set({ authorId: e.target.value ? Number(e.target.value) : undefined })}>
            <option value="">All subjects</option>
            {props.authors
              .filter((a) => a.canonicalId === a.id)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          From
          <input type="date" value={f.from} onChange={(e) => set({ from: e.target.value })} />
        </label>
        <label>
          To
          <input type="date" value={f.to} onChange={(e) => set({ to: e.target.value })} />
        </label>
        <label>
          Path
          <input
            type="text"
            placeholder="(whole repository)"
            value={f.path}
            onChange={(e) => set({ path: e.target.value })}
          />
        </label>
        <div className="filter-actions">
          <button className="secondary" onClick={() => setPickerOpen(true)} disabled={!props.repoId}>
            Commits {f.commits.length > 0 ? `(${f.commits.length})` : ''}
          </button>
          {hasFilters && (
            <button
              className="secondary"
              onClick={() => props.onFiltersChange({ ...emptyFilters })}
            >
              ↺ Reset
            </button>
          )}
        </div>
      </div>
      {pickerOpen && props.repoId && (
        <CommitPicker
          repoId={props.repoId}
          selected={f.commits}
          onApply={(hashes) => {
            set({ commits: hashes });
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </section>
  );
}
