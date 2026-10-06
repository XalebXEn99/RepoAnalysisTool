import { useEffect, useId, useRef, useState } from 'react';
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

function RepositoryHeading(props: {
  repos: RepositorySummary[];
  repoId: number | undefined;
  onRepoChange: (id: number) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const picker = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const carouselId = useId();
  const repo = props.repos.find((item) => item.id === props.repoId);
  const ingesting = repo?.status === 'pending' || repo?.status === 'ingesting';

  useEffect(() => {
    if (!pickerOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !picker.current?.contains(event.target)) setPickerOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [pickerOpen]);

  const closePicker = () => {
    setPickerOpen(false);
    toggle.current?.focus();
  };

  const scrollRepos = (direction: number) => {
    if (!track.current) return;
    track.current.scrollBy({
      left: direction * Math.max(120, track.current.clientWidth * 0.8),
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  };

  return (
    <header className="repository-header">
      <div className={`repository-heading${pickerOpen ? ' switching' : ''}`}>
        <h1 title={repo?.name}>{repo?.name ?? 'Dashboard'}</h1>
        <div
          className={`repo-switcher${pickerOpen ? ' is-open' : ''}`}
          ref={picker}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setPickerOpen(false);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              closePicker();
            }
          }}
        >
          <button
            type="button"
            className="repo-switcher-toggle"
            ref={toggle}
            aria-label="Switch repository"
            title="Switch repository"
            aria-expanded={pickerOpen}
            aria-controls={carouselId}
            onClick={() => setPickerOpen((open) => !open)}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4" />
            </svg>
          </button>
          <div
            id={carouselId}
            className="repository-carousel"
            role="group"
            aria-label="Available repositories"
            aria-hidden={!pickerOpen}
          >
            <button type="button" className="carousel-step" aria-label="Scroll repositories left" tabIndex={pickerOpen ? 0 : -1} onClick={() => scrollRepos(-1)} disabled={props.repos.length === 0}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg>
            </button>
            <div
              className="repository-options"
              ref={track}
              onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                const buttons = [...event.currentTarget.querySelectorAll('button')];
                const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
                if (index < 0) return;
                event.preventDefault();
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : index + (event.key === 'ArrowRight' ? 1 : -1);
                buttons[Math.max(0, Math.min(buttons.length - 1, next))]?.focus();
              }}
            >
              {props.repos.length === 0 && <p className="muted text-small">No repositories yet. Use + to add one.</p>}
              {props.repos.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  tabIndex={pickerOpen ? 0 : -1}
                  aria-current={item.id === props.repoId ? 'true' : undefined}
                  title={`${item.name} — ${item.status}`}
                  onClick={() => {
                    props.onRepoChange(item.id);
                    closePicker();
                  }}
                >
                  {item.name}
                </button>
              ))}
            </div>
            <button type="button" className="carousel-step" aria-label="Scroll repositories right" tabIndex={pickerOpen ? 0 : -1} onClick={() => scrollRepos(1)} disabled={props.repos.length === 0}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m10 6 6 6-6 6" /></svg>
            </button>
          </div>
        </div>
      </div>
      {ingesting && <RatWheelLoader compact label={repo.status === 'pending' ? 'Queued for ingestion…' : 'Ingesting repository…'} />}
    </header>
  );
}

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
  const repo = props.repos.find((item) => item.id === props.repoId);
  const repoStatus = repo?.status;

  useEffect(() => {
    if (!props.repoId || repoStatus !== 'ready') {
      setSummary(null);
      setObject(null);
      setChildren(null);
      setLoading(false);
      setError('');
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
          setSummary(null);
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
  }, [props.repoId, props.filters, repoStatus]);

  return (
    <>
      <RepositoryHeading repos={props.repos} repoId={props.repoId} onRepoChange={props.onRepoChange} />
      {!props.repoId && (
        <section className="panel">
          <p className="muted">Choose a repository using the switch beside the title, or use <strong>+</strong> to add one.</p>
        </section>
      )}
      {repo?.status === 'error' && (
        <section className="panel">
          <p className="error-text">{repo.error ?? 'Repository ingestion failed.'}</p>
        </section>
      )}
      {props.repoId && (
        <FilterBar
          key={props.repoId}
          repoId={props.repoId}
          authors={props.authors}
          filters={props.filters}
          onFiltersChange={props.onFiltersChange}
        />
      )}
      {loading && <RatWheelLoader />}
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
        <p className="muted text-small">
          raw: <code>/api/metrics/summary{query({ repo: props.repoId })}</code>
        </p>
      )}
    </>
  );
}
