import { useCallback, useEffect, useState } from 'react';
import { api } from './lib/api';
import { Layout, type PageId } from './components/Layout';
import { emptyFilters, type UiFilters } from './components/FilterBar';
import { DashboardPage } from './pages/DashboardPage';
import { RepositoriesPage } from './pages/RepositoriesPage';
import { AddRepoPage } from './pages/AddRepoPage';
import { AuthorsPage } from './pages/AuthorsPage';
import type { AuthorInfo, RepositorySummary } from '../shared/types';

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
        setRepoId((current) => current ?? list.find((r) => r.status === 'ready')?.id ?? list[0]?.id);
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

  useEffect(() => {
    if (!repoId) {
      setAuthors([]);
      return;
    }
    api
      .authors(repoId)
      .then(setAuthors)
      .catch(() => setAuthors([]));
  }, [repoId, repos]);

  const changeRepo = (id: number) => {
    setRepoId(id);
    setFilters(emptyFilters);
  };

  return (
    <Layout page={page} onNavigate={setPage}>
      {fatal && (
        <section className="panel">
          <p className="error-text">cannot reach the RAT server: {fatal}</p>
        </section>
      )}
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
          onAdd={() => setPage('add')}
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
          }}
        />
      )}
      {page === 'authors' && <AuthorsPage repos={repos} repoId={repoId} onRepoChange={changeRepo} />}
    </Layout>
  );
}
