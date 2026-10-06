import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AuthorMetricRow, ObjectMetrics, TimelinePoint } from '../../shared/types';

const fmt = new Intl.NumberFormat('en-US');
export const num = (value: number): string => fmt.format(value);
export const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
export const fixed = (value: number, digits = 2): string => value.toFixed(digits);

export function MetricCards(props: { metrics: ObjectMetrics; title: string }) {
  const m = props.metrics;
  const cards: Array<{ label: string; value: string; hint: string }> = [
    { label: 'Added lines  l⁺', value: num(m.added), hint: 'Σ l⁺ over H' },
    { label: 'Removed lines  l⁻', value: num(m.removed), hint: 'Σ l⁻ over H' },
    { label: 'Growth  δ', value: num(m.growth), hint: 'l⁺ − l⁻' },
    { label: 'Churn  λ', value: num(m.churn), hint: 'l⁺ + l⁻' },
    { label: 'Modifications  n', value: num(m.modifications), hint: 'commits with λ > 0' },
    { label: 'Mod. frequency  η', value: fixed(m.modificationFrequency, 4), hint: `n / |H|, |H| = ${num(m.commitCount)}` },
    { label: 'Churn rate  ρ', value: fixed(m.churnRate, 2), hint: 'λ / |H|' },
  ];
  return (
    <section className="panel">
      <div className="spread">
        <h2>{props.title}</h2>
        <span className="muted">commit set |H| = {num(m.commitCount)}</span>
      </div>
      <div className="cards">
        {cards.map((c) => (
          <div className="card" key={c.label}>
            <div className="label">{c.label}</div>
            <div className="value">{c.value}</div>
            <div className="hint">{c.hint}</div>
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
  return (
    <section className="panel">
      <h2>{props.title}</h2>
      {props.rows.length === 0 ? (
        <p className="muted">No data for the current filters.</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>path</th>
              <th>kind</th>
              <th className="num">l⁺</th>
              <th className="num">l⁻</th>
              <th className="num">δ</th>
              <th className="num">λ</th>
              <th className="num">n</th>
              <th className="num">η</th>
              <th className="num">ρ</th>
            </tr>
          </thead>
          <tbody>
            {props.rows.map((r) => (
              <tr
                key={r.path || '(root)'}
                className={props.onPick ? 'clickable' : ''}
                onClick={() => props.onPick?.(r)}
              >
                <td>{r.path === '' ? '(repository root)' : r.path}</td>
                <td>{r.kind}</td>
                <td className="num">{num(r.added)}</td>
                <td className="num">{num(r.removed)}</td>
                <td className="num">{num(r.growth)}</td>
                <td className="num">{num(r.churn)}</td>
                <td className="num">{num(r.modifications)}</td>
                <td className="num">{fixed(r.modificationFrequency, 4)}</td>
                <td className="num">{fixed(r.churnRate, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function AuthorOwnershipTable(props: { rows: AuthorMetricRow[] }) {
  return (
    <section className="panel">
      <h2>Author ownership ω</h2>
      {props.rows.length === 0 ? (
        <p className="muted">No authorship data for the current filters.</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>author</th>
              <th className="num">n (modifications)</th>
              <th className="num">λ (churn)</th>
              <th className="num">ω (ownership)</th>
              <th style={{ width: '30%' }}></th>
            </tr>
          </thead>
          <tbody>
            {props.rows.map((r) => (
              <tr key={r.authorId}>
                <td>{r.authorName}</td>
                <td className="num">{num(r.modifications)}</td>
                <td className="num">{num(r.churn)}</td>
                <td className="num">{pct(r.ownership)}</td>
                <td>
                  <div className="progress">
                    <div style={{ width: pct(r.ownership) }} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function TimelineChart(props: { points: TimelinePoint[] }) {
  return (
    <section className="panel">
      <h2>Churn over time (monthly)</h2>
      {props.points.length === 0 ? (
        <p className="muted">No data for the current filters.</p>
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={props.points}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e3e7ec" />
            <XAxis dataKey="label" fontSize={11} />
            <YAxis fontSize={11} />
            <Tooltip />
            <Legend />
            <Bar dataKey="added" stackId="a" fill="#1a7f37" name="added" />
            <Bar dataKey="removed" stackId="a" fill="#b3261e" name="removed" />
          </BarChart>
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
