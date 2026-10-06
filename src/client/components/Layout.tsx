import type { ReactNode } from 'react';
import ratLogo from '../assets/rat-logo.png';

export type PageId = 'dashboard' | 'repositories' | 'add' | 'authors';

const NAV: Array<{ id: PageId; label: string; icon: string }> = [
  { id: 'dashboard', label: 'Dashboard', icon: '🔬' },
  { id: 'repositories', label: 'Repositories', icon: '🧪' },
  { id: 'authors', label: 'Authors', icon: '🐀' },
];

export function Layout(props: { page: PageId; onNavigate: (page: PageId) => void; children: ReactNode }) {
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand-row">
          <img src={ratLogo} alt="RAT" className="brand-rat" />
          <span className="brand">RAT</span>
          <button
            className="add-btn"
            title="Add repository"
            onClick={() => props.onNavigate('add')}
          >
            +
          </button>
        </div>
        <div className="tagline">Repo Analysis Tool</div>
        <nav>
          {NAV.map((item) => (
            <button
              key={item.id}
              className={props.page === item.id ? 'active' : ''}
              onClick={() => props.onNavigate(item.id)}
            >
              <span className="nav-icon">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="lab-footer">
          <img src={ratLogo} alt="" />
        </div>
      </aside>
      <main className="content">{props.children}</main>
    </div>
  );
}
