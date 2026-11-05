import { useState, type ReactNode } from 'react';
import { PALETTES, readAppearance, saveAppearance, type Appearance } from '../lib/appearance';
import ratLogo from '../assets/rat-logo.png';
import labcoatLight from '../assets/labcoat-light.png';
import labcoatDark from '../assets/labcoat-dark.png';
import ratCageLight from '../assets/rat-cage-light.png';
import ratCageDark from '../assets/rat-cage-dark.png';
import scienceBoardLight from '../assets/science-board-light.png';
import scienceBoardDark from '../assets/science-board-dark.png';
import { RunningRat } from './RunningRat';

export type PageId = 'dashboard' | 'repositories' | 'add' | 'authors';

const NAV: Array<{ id: 'dashboard' | 'repositories' | 'authors'; label: string }> = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'repositories', label: 'Repositories' },
  { id: 'authors', label: 'Authors' },
];

export function Layout(props: {
  page: PageId;
  onNavigate: (page: PageId) => void;
  children: ReactNode;
}) {
  const [appearance, setAppearance] = useState(readAppearance);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const dark = appearance.palette.endsWith('dark');
  const navigationIcons = {
    dashboard: dark ? scienceBoardDark : scienceBoardLight,
    repositories: dark ? ratCageDark : ratCageLight,
    authors: dark ? labcoatDark : labcoatLight,
  };
  const updateAppearance = (patch: Partial<Appearance>) => {
    const next = { ...appearance, ...patch };
    saveAppearance(next);
    setAppearance(next);
  };

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand-row">
          <img src={ratLogo} alt="RAT" className="brand-rat" />
          <span className="brand">RAT</span>
          <button
            className="add-btn"
            title="Add repository"
            aria-label="Add repository"
            onClick={() => props.onNavigate('add')}
          >
            +
          </button>
        </div>
        <div className="tagline">Repo Analysis Tool</div>
        <nav aria-label="Main navigation">
          {NAV.map((item) => (
            <button
              key={item.id}
              className={props.page === item.id ? 'active' : ''}
              aria-current={props.page === item.id ? 'page' : undefined}
              onClick={() => props.onNavigate(item.id)}
            >
              <img
                className="navigation-icon"
                src={navigationIcons[item.id]}
                alt=""
              />
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-tools">
          <button
            type="button"
            className="settings-toggle"
            aria-expanded={settingsOpen}
            aria-controls="appearance-settings"
            onClick={() => setSettingsOpen((open) => !open)}
          >
            Settings
            <svg className={settingsOpen ? 'settings-chevron expanded' : 'settings-chevron'} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="m6 15 6-6 6 6" />
            </svg>
          </button>
          <section id="appearance-settings" className="appearance-controls" aria-label="Appearance" hidden={!settingsOpen}>
            <fieldset className="palette-picker">
              <legend>Palette</legend>
              <div className="palette-options">
                {PALETTES.map((palette) => (
                  <button
                    key={palette.id}
                    type="button"
                    className="palette-option"
                    aria-label={palette.label}
                    aria-pressed={appearance.palette === palette.id}
                    title={palette.label}
                    onClick={() => updateAppearance({ palette: palette.id })}
                  >
                    <span className={`palette-swatch ${palette.id}`} aria-hidden="true" />
                  </button>
                ))}
              </div>
            </fieldset>
            <div className="font-setting">
              <span id="pixel-font-label">Pixel font</span>
              <button
                type="button"
                className="font-switch"
                role="switch"
                aria-checked={appearance.pixelFont}
                aria-labelledby="pixel-font-label"
                onClick={() => updateAppearance({ pixelFont: !appearance.pixelFont })}
              >
                <span className="switch-thumb" aria-hidden="true" />
              </button>
            </div>
          </section>
        </div>
        <div className="lab-footer" aria-hidden="true">
          <div className="road-track">
            <div className="road-line top" />
            <RunningRat />
            <div className="road-line bottom" />
          </div>
        </div>
      </aside>
      <main className="content">{props.children}</main>
    </div>
  );
}
