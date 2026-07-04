import { useState } from 'react';
import { api } from './api';
import { Field } from './App';
import { IconPlus, IconWand } from './Icons';
import type { AppConfig, Story } from './types';

type Run = <T>(fn: () => Promise<T>) => Promise<T | undefined>;

export function formatRuntime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m} min ${s}s` : `${m} min`;
}

export function RuntimeSelect({
  config,
  value,
  onChange,
  allowDefault,
  disabled,
}: {
  config: AppConfig;
  value: number | null;
  onChange: (v: number | null) => void;
  allowDefault?: boolean;
  disabled?: boolean;
}) {
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      disabled={disabled}
    >
      {allowDefault && <option value="">story default</option>}
      {config.episodeRuntimes.map((r) => (
        <option key={r} value={r}>
          {formatRuntime(r)}
        </option>
      ))}
    </select>
  );
}

/**
 * Season & episode generation panel:
 * - random stories: "generate next standalone episode" with runtime + guidance.
 * - linear stories: season plan (create / extend / table with produced status)
 *   and "generate next planned episode".
 */
export function SeasonPanel({
  story,
  config,
  run,
  onChanged,
}: {
  story: Story;
  config: AppConfig;
  run: Run;
  onChanged: () => void;
}) {
  const [model, setModel] = useState(config.dissect.defaultModel);
  const [runtime, setRuntime] = useState<number | null>(null);
  const [guidance, setGuidance] = useState('');
  const [planCount, setPlanCount] = useState(6);
  const [extendCount, setExtendCount] = useState(3);
  const [pending, setPending] = useState<string | null>(null);

  const plan = story.plan;
  const producedCount = plan?.episodes.filter((e) => e.episodeId).length ?? 0;
  const nextSlot = plan?.episodes.find((e) => !e.episodeId) ?? null;

  const generate = async () => {
    setPending('episode');
    try {
      const res = await run(() =>
        api.generateEpisode(story.id, {
          model,
          runtimeSec: runtime ?? undefined,
          guidance: story.continuity === 'random' && guidance.trim() ? guidance.trim() : undefined,
        }),
      );
      if (res) {
        setGuidance('');
        onChanged();
      }
    } finally {
      setPending(null);
    }
  };

  return (
    <section className="card highlight">
      <div className="card-head">
        <h3>{story.continuity === 'linear' ? 'Season plan (linear story)' : 'Next episode (episodic story)'}</h3>
        <select value={model} onChange={(e) => setModel(e.target.value)} title="AI model">
          {config.dissect.models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      {story.continuity === 'random' && (
        <>
          <p className="muted small">
            Standalone episodes reusing the canon — the series can run forever. The AI avoids repeating existing
            episodes.
          </p>
          <div className="row">
            <Field label="Runtime">
              <RuntimeSelect config={config} value={runtime} onChange={setRuntime} allowDefault disabled={pending !== null} />
            </Field>
            <Field label="Guidance (optional)">
              <input
                value={guidance}
                onChange={(e) => setGuidance(e.target.value)}
                placeholder='e.g. "something at the pond"'
                disabled={pending !== null}
              />
            </Field>
            <button className="primary" onClick={generate} disabled={pending !== null}>
              <IconWand /> {pending === 'episode' ? 'Generating…' : 'Generate next episode'}
            </button>
          </div>
        </>
      )}

      {story.continuity === 'linear' && !plan && (
        <>
          <p className="muted small">
            Linear stories follow a planned season arc — every episode builds on the previous one until the finale.
            Plan the season first; each episode is then generated in order with full continuity context.
          </p>
          <div className="row">
            <Field label="Episodes in season">
              <input
                type="number"
                min={2}
                max={50}
                value={planCount}
                onChange={(e) => setPlanCount(Number(e.target.value))}
                disabled={pending !== null}
              />
            </Field>
            <button
              className="primary"
              disabled={pending !== null}
              onClick={async () => {
                setPending('plan');
                try {
                  const res = await run(() => api.planStory(story.id, { episodeCount: planCount, model }));
                  if (res) onChanged();
                } finally {
                  setPending(null);
                }
              }}
            >
              <IconWand /> {pending === 'plan' ? 'Planning season…' : 'Plan the season'}
            </button>
          </div>
        </>
      )}

      {story.continuity === 'linear' && plan && (
        <>
          <p className="small">
            <b>Arc:</b> {plan.arcSummary}
          </p>
          <p className="muted small">
            <b>Finale:</b> {plan.finale}
          </p>
          <table className="plan-table">
            <tbody>
              {plan.episodes.map((e) => (
                <tr key={e.number} className={e.episodeId ? 'produced' : nextSlot?.number === e.number ? 'next' : ''}>
                  <td className="plan-num">{e.number}</td>
                  <td>
                    <b>{e.title}</b>
                    <div className="muted small">{e.synopsis}</div>
                    <div className="muted small">Arc: {e.arcNote}</div>
                  </td>
                  <td className="plan-status">
                    {e.episodeId ? (
                      <span className="badge live">produced</span>
                    ) : nextSlot?.number === e.number ? (
                      <span className="badge warn">next up</span>
                    ) : (
                      <span className="badge">planned</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row">
            {nextSlot ? (
              <>
                <Field label="Runtime">
                  <RuntimeSelect config={config} value={runtime} onChange={setRuntime} allowDefault disabled={pending !== null} />
                </Field>
                <button className="primary" onClick={generate} disabled={pending !== null}>
                  <IconWand /> {pending === 'episode' ? 'Generating…' : `Generate episode ${nextSlot.number}: ${nextSlot.title}`}
                </button>
              </>
            ) : (
              <span className="muted small">All {plan.episodes.length} planned episodes are produced.</span>
            )}
            <Field label="Extend by">
              <input
                type="number"
                min={1}
                max={30}
                value={extendCount}
                onChange={(e) => setExtendCount(Number(e.target.value))}
                disabled={pending !== null}
              />
            </Field>
            <button
              disabled={pending !== null}
              title="Continue the arc: the current finale becomes a mid-season beat and new episodes lead to a new finale"
              onClick={async () => {
                setPending('extend');
                try {
                  const res = await run(() => api.extendPlan(story.id, { additionalEpisodes: extendCount, model }));
                  if (res) onChanged();
                } finally {
                  setPending(null);
                }
              }}
            >
              <IconPlus /> {pending === 'extend' ? 'Extending…' : 'Extend season'}
            </button>
          </div>
          <p className="muted small">
            {producedCount}/{plan.episodes.length} produced · planned with {plan.model}
          </p>
        </>
      )}
    </section>
  );
}
