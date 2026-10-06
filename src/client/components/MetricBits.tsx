import { useState } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Label, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AuthorMetricRow, ObjectMetrics, TimelinePoint } from '../../shared/types';

const fmt = new Intl.NumberFormat('en-US');
export const num = (value: number): string => fmt.format(value);
export const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
export const fixed = (value: number, digits = 2): string => value.toFixed(digits);

const PAGE_SIZE = 15;

export function MetricCards(props: { metrics: ObjectMetrics; title: string }) {
  const m = props.metrics;
  const cards: Array<{ label: string; value: string }> = [
    { label: 'Lines Added', value: num(m.added) },
    { label: 'Lines Removed', value: num(m.removed) },
    { label: 'Growth', value: num(m.growth) },
    { label: 'Churn', value: num(m.churn) },
    { label: 'Modifications', value: num(m.modifications) },
    { label: 'Mod. Frequency', value: fixed(m.modificationFrequency, 4) },
    { label: 'Churn Rate', value: fixed(m.churnRate, 2) },
  ];
  return (
    <section className="panel">
      <div className="spread">
        <h2>{props.title}</h2>
        <span className="badge">{num(m.commitCount)} commits</span>
      </div>
      <div className="cards">
        {cards.map((c) => (
          <div className="card" key={c.label}>
            <div className="label">{c.label}</div>
            <div className="value">{c.value}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function ObjectTable(props: {
  title: string;
  rows: ObjectMetrics[];
  onPick?: (row: ObjectMetrics) => void;
}) {
  const [visible, setVisible] = useState(PAGE_SIZE);
  const shown = props.rows.slice(0, visible);
  const hasMore = props.rows.length > visible;

  return (
    <section className="panel">
      <h2>{props.title}</h2>
      {props.rows.length === 0 ? (
        <p className="muted">No data for the current filters.</p>
      ) : (
        <>
          <div className="table-container">
            <table className="grid">
              <thead>
                <tr>
                  <th>Path</th>
                  <th>Type</th>
                  <th className="num">Added</th>
                  <th className="num">Removed</th>
                  <th className="num">Growth</th>
                  <th className="num">Churn</th>
                  <th className="num">Mods</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr
                    key={r.path || '(root)'}
                    className={props.onPick ? 'clickable' : ''}
                    onClick={() => props.onPick?.(r)}
                  >
                    <td>{r.path === '' ? '(repository root)' : r.path}</td>
                    <td><span className="badge">{r.kind}</span></td>
                    <td className="num">{num(r.added)}</td>
                    <td className="num">{num(r.removed)}</td>
                    <td className="num">{num(r.growth)}</td>
                    <td className="num">{num(r.churn)}</td>
                    <td className="num">{num(r.modifications)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {hasMore && (
            <div className="load-more-row">
              <button onClick={() => setVisible((v) => v + PAGE_SIZE)}>
                Load more ({props.rows.length - visible} remaining)
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function AuthorOwnershipTable(props: { rows: AuthorMetricRow[] }) {
  const [visible, setVisible] = useState(PAGE_SIZE);
  const shown = props.rows.slice(0, visible);
  const hasMore = props.rows.length > visible;

  return (
    <section className="panel">
      <h2>Author Ownership</h2>
      {props.rows.length === 0 ? (
        <p className="muted">No authorship data for the current filters.</p>
      ) : (
        <>
          <div className="table-container">
            <table className="grid">
              <thead>
                <tr>
                  <th>Author</th>
                  <th className="num">Modifications</th>
                  <th className="num">Churn</th>
                  <th className="num">Ownership</th>
                  <th style={{ width: '25%' }}>Contribution</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.authorId}>
                    <td>{r.authorName}</td>
                    <td className="num">{num(r.modifications)}</td>
                    <td className="num">{num(r.churn)}</td>
                    <td className="num">{pct(r.ownership)}</td>
                    <td>
                      <div className="water-bottle-bar">
                        <div className="bottle-track">
                          <div className="bottle-fill" style={{ width: pct(r.ownership) }} />
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
                Load more ({props.rows.length - visible} remaining)
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

const CHURN_VIEWS = [
  { id: 'bar', label: 'Bar chart', icon: 'M3 21h18M5 17v-6h3v6H5Zm6 0V3h3v14h-3Zm6 0V7h3v10h-3Z', description: 'Stacked monthly additions and removals; total height is churn.' },
  { id: 'line', label: 'Line chart', icon: 'M3 3v18h18M6 15l4-5 4 3 6-8', description: 'Compare monthly additions and removals as separate trends.' },
  { id: 'area', label: 'Area chart', icon: 'M3 3v18h18M6 17v-5l4-5 4 4 6-7v13H6Z', description: 'Stacked monthly additions and removals; total height is churn.' },
  { id: 'pie', label: 'Pie chart', icon: 'M11 3a9 9 0 1 0 10 10H11V3Zm4 0v6h6a8 8 0 0 0-6-6Z', description: 'Share of total churn from additions and removals across the selected period.' },
  { id: 'doughnut', label: 'Doughnut chart', icon: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM12 3v5m4 4h5', description: 'Share of total churn from additions and removals across the selected period.' },
] as const;
type ChurnView = (typeof CHURN_VIEWS)[number]['id'];
const CHURN_VIEW_KEY = 'rat.churnView';
const compactNumber = new Intl.NumberFormat('en-US', { notation: 'compact' });

export function TimelineChart(props: { points: TimelinePoint[] }) {
  const [view, setView] = useState<ChurnView>(() => {
    try {
      const saved = localStorage.getItem(CHURN_VIEW_KEY);
      return CHURN_VIEWS.find((option) => option.id === saved)?.id ?? 'bar';
    } catch {
      return 'bar';
    }
  });
  const changeView = (next: ChurnView) => {
    setView(next);
    try {
      localStorage.setItem(CHURN_VIEW_KEY, next);
    } catch {
      // The selector still works when browser storage is unavailable.
    }
  };
  const circular = view === 'pie' || view === 'doughnut';
  const totals = props.points.reduce((sum, point) => ({ added: sum.added + point.added, removed: sum.removed + point.removed }), { added: 0, removed: 0 });
  const totalChurn = totals.added + totals.removed;
  const slices = [
    { name: 'Added', value: totals.added, color: 'var(--accent)', className: 'added' },
    { name: 'Removed', value: totals.removed, color: 'var(--chart-secondary)', className: 'removed' },
  ];
  const Chart = view === 'line' ? LineChart : view === 'area' ? AreaChart : BarChart;
  const animate = typeof window !== 'undefined' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  return (
    <section className="chart-panel" aria-label="Churn chart">
      <div className="chart-toolbar">
        <h2>{circular ? 'Churn Breakdown' : 'Churn Over Time (monthly)'}</h2>
        <div className="chart-view-picker" role="group" aria-label="Churn chart type">
          {CHURN_VIEWS.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={view === option.id}
              aria-label={option.label}
              title={option.label}
              onClick={() => changeView(option.id)}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d={option.icon} />
              </svg>
            </button>
          ))}
        </div>
      </div>
      <p className="chart-description muted text-small">{CHURN_VIEWS.find((option) => option.id === view)?.description}</p>
      {props.points.length === 0 ? (
        <p className="muted">No data for the current filters.</p>
      ) : circular ? (
        totalChurn === 0 ? (
          <p className="muted">No added or removed lines in the current selection.</p>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie
                  key={view}
                  data={slices}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius={view === 'doughnut' ? '55%' : 0}
                  outerRadius="85%"
                  startAngle={90}
                  endAngle={-270}
                  stroke="var(--panel)"
                  strokeWidth={3}
                  isAnimationActive={animate}
                  animationDuration={350}
                >
                  {slices.map((slice) => <Cell key={slice.name} fill={slice.color} />)}
                  {view === 'doughnut' && <Label className="churn-total" value={compactNumber.format(totalChurn)} position="center" />}
                </Pie>
                <Tooltip
                  formatter={(value: number) => `${num(value)} lines (${pct(value / totalChurn)})`}
                  contentStyle={{ background: 'var(--panel)', color: 'var(--ink)', border: '1px solid var(--line)', borderRadius: 8, fontSize: 'var(--text-sm)' }}
                  itemStyle={{ color: 'var(--ink)' }}
                />
              </PieChart>
            </ResponsiveContainer>
            <p className="churn-total-caption">Total churn: <strong>{num(totalChurn)}</strong> lines</p>
            <ul className="churn-breakdown">
              {slices.map((slice) => (
                <li key={slice.name}>
                  <span className={`churn-swatch ${slice.className}`} aria-hidden="true" />
                  <span>{slice.name}: <strong>{num(slice.value)}</strong> ({pct(slice.value / totalChurn)})</span>
                </li>
              ))}
            </ul>
          </>
        )
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <Chart data={props.points} accessibilityLayer margin={{ top: 10, right: 12, bottom: 4, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
            <XAxis dataKey="label" stroke="var(--muted)" minTickGap={40} />
            <YAxis stroke="var(--muted)" width={72} allowDecimals={false} tickFormatter={(value: number) => compactNumber.format(value)} />
            <Tooltip
              cursor={view === 'bar' ? { fill: 'var(--accent-soft)' } : { stroke: 'var(--muted)', strokeDasharray: '4 4' }}
              formatter={(value: number) => num(value)}
              contentStyle={{ background: 'var(--panel)', color: 'var(--ink)', border: '1px solid var(--line)', borderRadius: 8, fontSize: 'var(--text-sm)' }}
              labelStyle={{ color: 'var(--ink)' }}
              itemStyle={{ color: 'var(--ink)' }}
            />
            <Legend wrapperStyle={{ fontSize: 'var(--text-xs)', color: 'var(--ink)' }} />
            {view === 'bar' && (
              <>
                <Bar dataKey="added" stackId="churn" fill="var(--accent)" stroke="var(--accent-text)" name="Added" maxBarSize={48} isAnimationActive={animate} animationDuration={350} />
                <Bar dataKey="removed" stackId="churn" fill="var(--chart-secondary)" name="Removed" radius={[3, 3, 0, 0]} maxBarSize={48} isAnimationActive={animate} animationDuration={350} />
              </>
            )}
            {view === 'line' && (
              <>
                <Line type="linear" dataKey="added" stroke="var(--accent-text)" strokeWidth={2.5} name="Added" dot={props.points.length <= 18 ? { r: 3 } : false} activeDot={{ r: 5, stroke: 'var(--panel)', strokeWidth: 2 }} isAnimationActive={animate} animationDuration={350} />
                <Line type="linear" dataKey="removed" stroke="var(--chart-secondary)" strokeWidth={2.5} strokeDasharray="6 4" name="Removed" dot={props.points.length <= 18 ? { r: 3 } : false} activeDot={{ r: 5, stroke: 'var(--panel)', strokeWidth: 2 }} isAnimationActive={animate} animationDuration={350} />
              </>
            )}
            {view === 'area' && (
              <>
                <Area type="linear" dataKey="added" stackId="churn" stroke="var(--accent-text)" strokeWidth={2} fill="var(--accent)" fillOpacity={0.3} name="Added" dot={props.points.length === 1 ? { r: 3 } : false} activeDot={{ r: 5, stroke: 'var(--panel)', strokeWidth: 2 }} isAnimationActive={animate} animationDuration={350} />
                <Area type="linear" dataKey="removed" stackId="churn" stroke="var(--chart-secondary)" strokeWidth={2} strokeDasharray="6 4" fill="var(--chart-secondary)" fillOpacity={0.2} name="Removed" dot={props.points.length === 1 ? { r: 3 } : false} activeDot={{ r: 5, stroke: 'var(--panel)', strokeWidth: 2 }} isAnimationActive={animate} animationDuration={350} />
              </>
            )}
          </Chart>
        </ResponsiveContainer>
      )}
    </section>
  );
}

export function Breadcrumbs(props: { path: string; onPick: (path: string) => void }) {
  const parts = props.path === '' ? [] : props.path.split('/');
  return (
    <div className="breadcrumbs">
      <button onClick={() => props.onPick('')}>repository</button>
      {parts.map((part, i) => {
        const target = parts.slice(0, i + 1).join('/');
        return (
          <span key={target}>
            <span className="sep">/</span>
            <button onClick={() => props.onPick(target)}>{part}</button>
          </span>
        );
      })}
    </div>
  );
}
