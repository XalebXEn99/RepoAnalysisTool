import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AuthorMetricRow, ObjectMetrics, TimelinePoint } from '../../shared/types';
import cheeseIcon from '../assets/cheese-point.png';
import waterBottle from '../assets/water-bottle.png';

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
            <img src={cheeseIcon} alt="" className="cheese-icon" />
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
                        <img src={waterBottle} alt="" className="bottle-icon" />
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

export function TimelineChart(props: { points: TimelinePoint[] }) {
  return (
    <div className="chart-panel">
      <h2>Churn Over Time (monthly)</h2>
      {props.points.length === 0 ? (
        <p className="muted" style={{ color: '#7a8594' }}>No data for the current filters.</p>
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={props.points}>
            <CartesianGrid strokeDasharray="3 3" stroke="#2a3040" />
            <XAxis dataKey="label" fontSize={10} stroke="#7a8594" />
            <YAxis fontSize={10} stroke="#7a8594" />
            <Tooltip
              contentStyle={{ background: '#1a1f2b', border: '1px solid #2a3040', borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: '#e6e9ee' }}
            />
            <Legend wrapperStyle={{ fontSize: 11, color: '#7a8594' }} />
            <Bar dataKey="added" stackId="a" fill="#16a34a" name="Added" radius={[0, 0, 0, 0]} />
            <Bar dataKey="removed" stackId="a" fill="#dc2626" name="Removed" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

export function Breadcrumbs(props: { path: string; onPick: (path: string) => void }) {
  const parts = props.path === '' ? [] : props.path.split('/');
  return (
    <div className="breadcrumbs">
      <button onClick={() => props.onPick('')}>🏠 repository</button>
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
