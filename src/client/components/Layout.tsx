import type { ReactNode } from 'react';

export type PageId = 'dashboard' | 'repositories' | 'add' | 'authors';

const NAV: Array<{ id: PageId; label: string }> = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'repositories', label: 'Repositories' },
  { id: 'add', label: 'Add repository' },
  { id: 'authors', label: 'Authors' },
];

export function Layout(props: { page: PageId; onNavigate: (page: PageId) => void; children: ReactNode }) {
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">RAT</div>
        <div className="tagline">Repo Analysis Tool</div>
        <nav>
          {NAV.map((item) => (
            <button
              key={item.id}
              className={props.page === item.id ? 'active' : ''}
              onClick={() => props.onNavigate(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="content">{props.children}</main>
    </div>
  );
}
