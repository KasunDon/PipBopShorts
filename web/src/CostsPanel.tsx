import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { IconChevronLeft, IconRefresh, IconX } from './Icons';
import type { CostLineItem, CostReport } from './types';

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
  const [drill, setDrill] = useState<{ storyId: string; items: CostLineItem[] } | null>(null);

  const sinceIso = useCallback(() => (sinceHours ? new Date(Date.now() - sinceHours * 3600_000).toISOString() : undefined), [sinceHours]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.costReport({ since: sinceIso() });
      setReport(res.report);
    } finally {
      setLoading(false);
    }
  }, [sinceIso]);

  const openStory = useCallback(
    async (storyId: string) => {
      const res = await api.costEvents({ storyId, since: sinceIso() });
      setDrill({ storyId, items: res.items });
    },
    [sinceIso],
  );

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="panel costs-panel">
      <div className="page-head">
        <button className="link back" onClick={onClose}>
          <IconChevronLeft /> Back
        </button>
        <h2 className="page-title">Costs — production spend</h2>
        <p className="page-sub">
          Spend across Claude (LLM) and PixVerse (video/image), derived from the local audit log.
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
            <IconRefresh /> Refresh
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
            <Tile label="Exact (Claude, billed)" value={fmtUsd(report.exactUsd)} />
            <Tile label="Estimated (PixVerse)" value={fmtUsd(report.estimatedUsd)} />
            <Tile label="PixVerse credits" value={fmtNum(report.totalCredits)} />
            <Tile label="LLM tokens (in/out)" value={`${fmtNum(report.tokens.inputTokens)} / ${fmtNum(report.tokens.outputTokens)}`} />
            <Tile label="Billable calls" value={fmtNum(report.billableCount)} />
          </section>
          {report.hasEstimates && (
            <p className="muted small">
              The <b>Exact</b> total is billed pennies reported by the Claude gateway. The <b>Estimated</b> total is
              PixVerse (which bills in credits, not per-call USD) — reconcile it against your PixVerse invoice, and tune
              the credit rate/table in <code>src/costs/pricing.ts</code> (or <code>PIXVERSE_CREDIT_USD</code>) to match
              your plan.
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
              <h3>By story <span className="muted small">— click a row to see every line item</span></h3>
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
                      <tr key={s.id} className="clickable-row" onClick={() => openStory(s.id)} title="View line items">
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

          {drill && (
            <section className="card">
              <div className="card-head">
                <h3>
                  Line items · <span className="mono">{drill.storyId}</span> ({drill.items.length})
                </h3>
                <button className="ghost small" onClick={() => setDrill(null)}>
                  <IconX /> Close
                </button>
              </div>
              <div className="cost-table-wrap">
                <table className="cost-table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Provider</th>
                      <th>Phase</th>
                      <th>Model/kind</th>
                      <th>Detail</th>
                      <th>Credits</th>
                      <th>USD</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drill.items.map((it) => (
                      <tr key={it.id}>
                        <td>{new Date(it.ts).toLocaleString()}</td>
                        <td>{it.provider}</td>
                        <td>{it.phase ?? '—'}</td>
                        <td>{it.model ?? it.kind}</td>
                        <td className="line-detail" title={it.breakdown.join('\n')}>{it.summary}</td>
                        <td>{it.credits ? fmtNum(it.credits) : '—'}</td>
                        <td>
                          {fmtUsd(it.usd)}
                          {!it.exact && <span className="muted small"> est</span>}
                        </td>
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
