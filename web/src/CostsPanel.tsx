import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { CostReport } from './types';

export function fmtUsd(usd: number): string {
  if (!usd) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtNum(n: number): string {
  return n.toLocaleString();
}

const SINCE_OPTIONS: Array<{ label: string; hours: number | null }> = [
  { label: 'All time', hours: null },
  { label: 'Last 24h', hours: 24 },
  { label: 'Last 7d', hours: 24 * 7 },
];

export function CostsPanel({ onClose }: { onClose: () => void }) {
  const [report, setReport] = useState<CostReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [sinceHours, setSinceHours] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const since = sinceHours ? new Date(Date.now() - sinceHours * 3600_000).toISOString() : undefined;
      const res = await api.costReport({ since });
      setReport(res.report);
    } finally {
      setLoading(false);
    }
  }, [sinceHours]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="panel costs-panel">
      <div className="panel-head">
        <button className="link" onClick={onClose}>
          ← Back
        </button>
        <h2>💰 Costs — production spend</h2>
        <p className="muted small">
          Estimated spend across Claude (LLM) and PixVerse (video/image), derived from the local audit log.
        </p>
      </div>

      <section className="card">
        <div className="row">
          <select value={String(sinceHours ?? 'all')} onChange={(e) => setSinceHours(e.target.value === 'all' ? null : Number(e.target.value))}>
            {SINCE_OPTIONS.map((o) => (
              <option key={o.label} value={String(o.hours ?? 'all')}>
                {o.label}
              </option>
            ))}
          </select>
          <button onClick={load} disabled={loading}>
            ↻ Refresh
          </button>
        </div>
      </section>

      {!report ? (
        <p className="muted small">Loading…</p>
      ) : report.billableCount === 0 ? (
        <p className="muted small">No billable activity yet — generate a storyline or render a scene.</p>
      ) : (
        <>
          <section className="cost-tiles">
            <Tile label="Total spend" value={fmtUsd(report.totalUsd)} accent />
            <Tile label="PixVerse credits" value={fmtNum(report.totalCredits)} />
            <Tile label="LLM tokens (in/out)" value={`${fmtNum(report.tokens.inputTokens)} / ${fmtNum(report.tokens.outputTokens)}`} />
            <Tile label="Billable calls" value={fmtNum(report.billableCount)} />
          </section>
          {report.hasEstimates && (
            <p className="muted small">
              ⚠️ PixVerse figures are estimates — tune the credit rate and table in <code>src/costs/pricing.ts</code> (or{' '}
              <code>PIXVERSE_CREDIT_USD</code>) to match your plan. Claude figures are the gateway's reported cost.
            </p>
          )}

          <div className="cost-grid">
            <BucketCard title="By provider" buckets={report.byProvider} />
            <BucketCard title="By kind" buckets={report.byKind} />
            <BucketCard title="By phase" buckets={report.byPhase} />
          </div>

          <section className="card">
            <h3>By model</h3>
            <div className="cost-table-wrap">
              <table className="cost-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Calls</th>
                    <th>In tokens</th>
                    <th>Out tokens</th>
                    <th>Credits</th>
                    <th>USD</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(report.byModel)
                    .sort((a, b) => b[1].usd - a[1].usd)
                    .map(([model, b]) => (
                      <tr key={model}>
                        <td>{model}</td>
                        <td>{fmtNum(b.count)}</td>
                        <td>{b.inputTokens ? fmtNum(b.inputTokens) : '—'}</td>
                        <td>{b.outputTokens ? fmtNum(b.outputTokens) : '—'}</td>
                        <td>{b.credits ? fmtNum(b.credits) : '—'}</td>
                        <td>{fmtUsd(b.usd)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </section>

          {report.byStory.length > 0 && (
            <section className="card">
              <h3>By story</h3>
              <div className="cost-table-wrap">
                <table className="cost-table">
                  <thead>
                    <tr>
                      <th>Story id</th>
                      <th>Calls</th>
                      <th>Credits</th>
                      <th>USD</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.byStory.map((s) => (
                      <tr key={s.id}>
                        <td className="mono">{s.id}</td>
                        <td>{fmtNum(s.count)}</td>
                        <td>{s.credits ? fmtNum(s.credits) : '—'}</td>
                        <td>{fmtUsd(s.usd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function Tile({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`cost-tile ${accent ? 'accent' : ''}`}>
      <div className="cost-tile-value">{value}</div>
      <div className="cost-tile-label">{label}</div>
    </div>
  );
}

function BucketCard({ title, buckets }: { title: string; buckets: Record<string, { usd: number; credits: number; count: number }> }) {
  const entries = Object.entries(buckets).sort((a, b) => b[1].usd - a[1].usd);
  return (
    <section className="card">
      <h3>{title}</h3>
      {entries.length === 0 ? (
        <p className="muted small">—</p>
      ) : (
        <ul className="bucket-list">
          {entries.map(([key, b]) => (
            <li key={key}>
              <span className="bucket-key">{key}</span>
              <span className="bucket-usd">{fmtUsd(b.usd)}</span>
              <span className="muted small">{b.count} call{b.count === 1 ? '' : 's'}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
