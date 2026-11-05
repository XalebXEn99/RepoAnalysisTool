import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { api } from './lib/api';
import { Layout, type PageId } from './components/Layout';
import { emptyFilters, type UiFilters } from './components/FilterBar';
import type { AuthorInfo, RepositorySummary } from '../shared/types';

const DashboardPage = lazy(() => import('./pages/DashboardPage').then((module) => ({ default: module.DashboardPage })));
const RepositoriesPage = lazy(() => import('./pages/RepositoriesPage').then((module) => ({ default: module.RepositoriesPage })));
const AddRepoPage = lazy(() => import('./pages/AddRepoPage').then((module) => ({ default: module.AddRepoPage })));
const AuthorsPage = lazy(() => import('./pages/AuthorsPage').then((module) => ({ default: module.AuthorsPage })));

export default function App() {
  const [page, setPage] = useState<PageId>('dashboard');
  const [repos, setRepos] = useState<RepositorySummary[]>([]);
  const [repoId, setRepoId] = useState<number | undefined>(undefined);
  const [authors, setAuthors] = useState<AuthorInfo[]>([]);
  const [filters, setFilters] = useState<UiFilters>(emptyFilters);
  const [fatal, setFatal] = useState('');

  const refresh = useCallback(() => {
    api
      .listRepos()
      .then((list) => {
        setRepos(list);
        setFatal('');
        setRepoId((current) => list.some((repo) => repo.id === current) ? current : list.find((r) => r.status === 'ready')?.id ?? list[0]?.id);
      })
      .catch((err: Error) => setFatal(err.message));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Keep polling while any repository is still ingesting.
  const busy = repos.some((r) => r.status === 'pending' || r.status === 'ingesting');
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(refresh, 2500);
    return () => clearInterval(timer);
  }, [busy, refresh]);

  const selectedStatus = repos.find((repo) => repo.id === repoId)?.status;
  useEffect(() => {
    if (!repoId) {
      setAuthors([]);
      return;
    }
    const controller = new AbortController();
    api
      .authors(repoId, controller.signal)
      .then((list) => setAuthors(list))
      .catch((err: Error) => {
        if (err.name !== 'AbortError') setFatal(`Cannot load authors: ${err.message}`);
      });
    return () => controller.abort();
  }, [repoId, selectedStatus]);

  const changeRepo = (id: number) => {
    setRepoId(id);
    setFilters(emptyFilters);
  };

  const navigate = (next: PageId) => {
    setPage(next);
  };

  return (
    <Layout page={page} onNavigate={navigate}>
      {fatal && (
        <section className="panel">
          <p className="error-text">Cannot reach the RAT server: {fatal}</p>
        </section>
      )}
      <Suspense fallback={<p role="status">Loading dashboard…</p>}>
      {page === 'dashboard' && (
        <DashboardPage
          repos={repos}
          authors={authors}
          repoId={repoId}
          filters={filters}
          onRepoChange={changeRepo}
          onFiltersChange={setFilters}
        />
      )}
      {page === 'repositories' && (
        <RepositoriesPage
          repos={repos}
          onRefresh={refresh}
          onAdd={() => navigate('add')}
          onSelect={(id) => {
            changeRepo(id);
            setPage('dashboard');
          }}
        />
      )}
      {page === 'add' && (
        <AddRepoPage
          onDone={(id) => {
            refresh();
            setRepoId(id);
            setPage('repositories');
          }}
        />
      )}
      {page === 'authors' && (
        <AuthorsPage
          repos={repos}
          repoId={repoId}
          onRepoChange={changeRepo}
          onAuthorsChanged={setAuthors}
        />
      )}
      </Suspense>
    </Layout>
  );
}
