import { useEffect, useState } from 'react';
import { api, query } from '../lib/api';
import { FilterBar, filtersToQuery, type UiFilters } from '../components/FilterBar';
import {
  AuthorOwnershipTable,
  Breadcrumbs,
  MetricCards,
  ObjectTable,
  TimelineChart,
} from '../components/MetricBits';
import { RatWheelLoader } from '../components/RatWheelLoader';
import type { AuthorInfo, ChildrenResponse, MetricsResponse, RepositorySummary, SummaryResponse } from '../../shared/types';

export function DashboardPage(props: {
  repos: RepositorySummary[];
  authors: AuthorInfo[];
  repoId: number | undefined;
  filters: UiFilters;
  onRepoChange: (id: number) => void;
  onFiltersChange: (f: UiFilters) => void;
}) {
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [object, setObject] = useState<MetricsResponse | null>(null);
  const [children, setChildren] = useState<ChildrenResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!props.repoId) {
      setSummary(null);
      setObject(null);
      setChildren(null);
      return;
    }
    let cancelled = false;
    setError('');
    setLoading(true);
    const base = filtersToQuery(props.repoId, { ...props.filters, path: '' });
    const scoped = filtersToQuery(props.repoId, props.filters);
    Promise.all([api.summary(base), api.object(scoped), api.children(scoped)])
      .then(([s, o, c]) => {
        if (cancelled) return;
        setSummary(s);
        setObject(o);
        setChildren(c);
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message);
          setObject(null);
          setChildren(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [props.repoId, props.filters]);

  if (!props.repoId) {
    return (
      <>
        <h1>Dashboard</h1>
        <section className="panel">
          <p className="muted">
            No specimen selected. Use the <strong>+</strong> button in the sidebar to add a repository, then pick it here.
          </p>
        </section>
        <FilterBar
          repos={props.repos}
          repoId={props.repoId}
          authors={props.authors}
          filters={props.filters}
          onRepoChange={props.onRepoChange}
          onFiltersChange={props.onFiltersChange}
        />
      </>
    );
  }

  const repo = props.repos.find((r) => r.id === props.repoId);

  return (
    <>
      <h1>🔬 {repo?.name ?? `repo ${props.repoId}`}</h1>
      {repo && repo.status !== 'ready' && (
        <section className="panel">
          <span className={`badge ${repo.status}`}>{repo.status}</span>{' '}
          <span className="muted">{repo.error ?? 'ingestion in progress…'}</span>
        </section>
      )}
      <FilterBar
        repos={props.repos}
        repoId={props.repoId}
        authors={props.authors}
        filters={props.filters}
        onRepoChange={props.onRepoChange}
        onFiltersChange={props.onFiltersChange}
      />
      {loading && <RatWheelLoader label="Analysing specimen…" />}
      {error && (
        <section className="panel">
          <p className="error-text">{error}</p>
        </section>
      )}
      {!loading && object && (
        <>
          <Breadcrumbs path={props.filters.path} onPick={(path) => props.onFiltersChange({ ...props.filters, path })} />
          <MetricCards
            title={props.filters.path === '' ? 'Repository Overview' : props.filters.path}
            metrics={object.metrics}
          />
          <TimelineChart points={object.timeline} />
          <AuthorOwnershipTable rows={object.authors} />
          {children && children.children.length > 0 && (
            <ObjectTable
              title={`Contents of ${props.filters.path === '' ? 'repository root' : props.filters.path}`}
              rows={children.children}
              onPick={(row) => props.onFiltersChange({ ...props.filters, path: row.path })}
            />
          )}
        </>
      )}
      {!loading && summary && (
        <>
          <ObjectTable title="Top Churned Files" rows={summary.topChurn} onPick={(r) => props.onFiltersChange({ ...props.filters, path: r.path })} />
          <ObjectTable title="Most Modified Files" rows={summary.topModified} onPick={(r) => props.onFiltersChange({ ...props.filters, path: r.path })} />
        </>
      )}
      {props.repoId && (
        <p className="muted" style={{ fontSize: 11, opacity: 0.6 }}>
          raw: <code>/api/metrics/summary{query({ repo: props.repoId })}</code>
        </p>
      )}
    </>
  );
}
