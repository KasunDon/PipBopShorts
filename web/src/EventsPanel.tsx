import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { fmtUsd } from './CostsPanel';
import { IconChevronLeft, IconCopy, IconRefresh, IconTrash } from './Icons';
import type { AuditEvent, EventService, EventStatus } from './types';

const SERVICES: EventService[] = ['claude', 'pixverse', 'youtube', 'store'];
const STATUSES: EventStatus[] = ['ok', 'error'];

/** Delete events whose preserved old value is self-contained enough to restore. */
const RESTORABLE = new Set(['store.storyline.delete', 'store.scene.delete']);
function isRestorable(event: AuditEvent): boolean {
  return RESTORABLE.has(event.type);
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function matchesFilters(e: AuditEvent, q: string, service: EventService | '', status: EventStatus | ''): boolean {
  if (service && e.service !== service) return false;
  if (status && e.status !== status) return false;
  if (q) {
    const needle = q.toLowerCase();
    const haystack = [e.summary, e.url, e.type, e.error ?? '', JSON.stringify(e.request), JSON.stringify(e.response)]
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

export function EventsPanel({ onClose }: { onClose: () => void }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [service, setService] = useState<EventService | ''>('');
  const [status, setStatus] = useState<EventStatus | ''>('');
  const [live, setLive] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = async (opts: { before?: string; replace?: boolean } = {}) => {
    setLoading(true);
    try {
      const res = await api.listEvents({
        q: debouncedQ || undefined,
        service: service || undefined,
        status: status || undefined,
        before: opts.before,
        limit: 50,
      });
      setEvents((prev) => (opts.replace ? res.events : [...prev, ...res.events]));
      setHasMore(res.hasMore);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load({ replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ, service, status]);

  const restore = async (event: AuditEvent) => {
    if (!confirm(`Restore this ${event.type.includes('scene') ? 'scene' : 'storyline'} from the audit log?`)) return;
    try {
      const res = await api.restoreFromAudit(event.id);
      alert(`Restored ${res.restored.kind} "${res.restored.label}".`);
      load({ replace: true });
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  // Real-time: prepend new events that match the active filters.
  const filtersRef = useRef({ debouncedQ, service, status });
  filtersRef.current = { debouncedQ, service, status };
  useEffect(() => {
    if (!live) return;
    const source = new EventSource('/api/events/stream');
    source.onmessage = (msg) => {
      if (!msg.data || msg.data.startsWith(':')) return;
      try {
        const event = JSON.parse(msg.data) as AuditEvent;
        const f = filtersRef.current;
        if (matchesFilters(event, f.debouncedQ, f.service, f.status)) {
          setEvents((prev) => [event, ...prev].slice(0, 1000));
        }
      } catch {
        // ignore malformed SSE frames
      }
    };
    return () => source.close();
  }, [live]);

  const counts = useMemo(() => {
    const ok = events.filter((e) => e.status === 'ok').length;
    const err = events.filter((e) => e.status === 'error').length;
    return { ok, err, total: events.length };
  }, [events]);

  return (
    <div className="panel events-panel">
      <div className="page-head">
        <button className="link back" onClick={onClose}>
          <IconChevronLeft /> Back
        </button>
        <h2 className="page-title">Activity — network and LLM audit log</h2>
        <p className="page-sub">
          Every outbound call to Claude, PixVerse, and YouTube — raw requests and responses, captured locally.
        </p>
      </div>

      <section className="card events-toolbar">
        <div className="row">
          <input
            className="events-search"
            placeholder="Search summaries, URLs, prompts, raw request/response…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select value={service} onChange={(e) => setService(e.target.value as EventService | '')} title="Filter by service">
            <option value="">All services</option>
            {SERVICES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value as EventStatus | '')} title="Filter by status">
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <label className="checkbox" title="Auto-append new events as they happen">
            <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
            Live
          </label>
          <button onClick={() => load({ replace: true })} disabled={loading}>
            <IconRefresh /> Refresh
          </button>
          <button
            className="danger ghost"
            onClick={async () => {
              if (confirm('Clear the entire local event log? This cannot be undone.')) {
                await api.clearEvents();
                setEvents([]);
                setHasMore(false);
              }
            }}
          >
            <IconTrash /> Clear
          </button>
        </div>
        <p className="muted small">
          Showing {counts.total} event{counts.total === 1 ? '' : 's'} · {counts.ok} ok · {counts.err} error{' '}
          {live && <span className="badge live">live</span>}
        </p>
      </section>

      <section className="card events-list-card">
        {events.length === 0 && !loading && <p className="muted small">No events yet — trigger a storyline generation or render a scene.</p>}
        <ul className="events-list">
          {events.map((e) => (
            <li key={e.id} className={`event-row status-${e.status}`}>
              <button className="event-row-head" onClick={() => setExpandedId(expandedId === e.id ? null : e.id)}>
                <span className="event-time">{new Date(e.ts).toLocaleTimeString()}</span>
                <span className={`badge svc-${e.service}`}>{e.service}</span>
                <span className={`badge ${e.status === 'ok' ? 'live' : 'bad'}`}>{e.status}</span>
                <span className="event-method">{e.method}</span>
                <span className="event-path">{pathOf(e.url)}</span>
                <span className="event-summary">{e.summary}</span>
                {e.cost && e.cost.usd > 0 && (
                  <span className="event-cost" title={e.cost.breakdown.join('\n')}>
                    {fmtUsd(e.cost.usd)}
                  </span>
                )}
                <span className="event-duration muted small">{e.durationMs}ms</span>
              </button>
              {expandedId === e.id && <EventDetail event={e} onRestore={() => restore(e)} />}
            </li>
          ))}
        </ul>
        {hasMore && (
          <button
            className="ghost"
            onClick={() => load({ before: events[events.length - 1]?.id })}
            disabled={loading}
          >
            {loading ? 'Loading…' : 'Load more'}
          </button>
        )}
      </section>
    </div>
  );
}

function EventDetail({ event, onRestore }: { event: AuditEvent; onRestore: () => void }) {
  const copy = (value: unknown) => {
    navigator.clipboard?.writeText(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  };
  return (
    <div className="event-detail">
      {isRestorable(event) && (
        <div className="event-restore">
          <span className="muted small">This deletion preserved the old value.</span>
          <button className="small" onClick={onRestore}>
            <IconRefresh /> Restore
          </button>
        </div>
      )}
      <div className="event-detail-meta">
        <div>
          <b>id</b> {event.id}
        </div>
        <div>
          <b>type</b> {event.type}
        </div>
        <div>
          <b>url</b> {event.url}
        </div>
        <div>
          <b>http</b> {event.httpStatus ?? '—'}
        </div>
        <div>
          <b>duration</b> {event.durationMs}ms
        </div>
        {event.error && (
          <div className="event-error">
            <b>error</b> {event.error}
          </div>
        )}
      </div>
      <div className="event-detail-blocks">
        <div className="event-block">
          <div className="event-block-head">
            <b>Request</b>
            <button className="ghost small" onClick={() => copy(event.request)}>
              <IconCopy /> Copy
            </button>
          </div>
          <pre>{JSON.stringify(event.request, null, 2)}</pre>
        </div>
        <div className="event-block">
          <div className="event-block-head">
            <b>Response</b>
            <button className="ghost small" onClick={() => copy(event.response)}>
              <IconCopy /> Copy
            </button>
          </div>
          <pre>{JSON.stringify(event.response, null, 2)}</pre>
        </div>
      </div>
    </div>
  );
}
