import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { Field } from './App';
import type { AppConfig, CanonRegistry, CanonVersion, Story, StoryMeta } from './types';

type Run = <T>(fn: () => Promise<T>) => Promise<T | undefined>;

const TYPE_ICONS: Record<string, string> = {
  character: '🧸',
  location: '🗺',
  prop: '🎈',
  relationship: '🤝',
  world_rule: '🌍',
  visual_style: '🎨',
  audience_tone: '👶',
};

export function StoryMetaEditor({ story, run, onSaved }: { story: Story; run: Run; onSaved: () => void }) {
  const [meta, setMeta] = useState<StoryMeta>(story.meta);
  useEffect(() => setMeta(story.meta), [story]);

  const set = <K extends keyof StoryMeta>(key: K, value: StoryMeta[K]) => setMeta((m) => ({ ...m, [key]: value }));

  return (
    <section className="card">
      <div className="card-head">
        <h3>Production metadata</h3>
        <button
          onClick={async () => {
            await run(() => api.updateStory(story.id, { meta }));
            onSaved();
          }}
        >
          Save metadata
        </button>
      </div>
      <div className="grid">
        <Field label="Audience age min">
          <input
            type="number"
            min={0}
            value={meta.audienceMin ?? ''}
            onChange={(e) => set('audienceMin', e.target.value === '' ? null : Number(e.target.value))}
          />
        </Field>
        <Field label="Audience age max">
          <input
            type="number"
            min={0}
            value={meta.audienceMax ?? ''}
            onChange={(e) => set('audienceMax', e.target.value === '' ? null : Number(e.target.value))}
          />
        </Field>
        <Field label="Genres (comma-separated)">
          <input
            value={meta.genres.join(', ')}
            placeholder="comedy, sci-fi, adventure"
            onChange={(e) => set('genres', e.target.value.split(',').map((t) => t.trim()).filter(Boolean))}
          />
        </Field>
        <Field label="Tones (comma-separated)">
          <input
            value={meta.tones.join(', ')}
            placeholder="cheerful, warm, safe"
            onChange={(e) => set('tones', e.target.value.split(',').map((t) => t.trim()).filter(Boolean))}
          />
        </Field>
        <Field label="Format">
          <input value={meta.format} placeholder="3D animated comedy shorts" onChange={(e) => set('format', e.target.value)} />
        </Field>
        <Field label="Episode length (sec)">
          <input
            type="number"
            min={5}
            value={meta.episodeLengthSec ?? ''}
            onChange={(e) => set('episodeLengthSec', e.target.value === '' ? null : Number(e.target.value))}
          />
        </Field>
      </div>
      <Field label="Audience notes">
        <input
          value={meta.audienceNotes}
          placeholder="e.g. must work with sound off; co-viewing parents"
          onChange={(e) => set('audienceNotes', e.target.value)}
        />
      </Field>
      <p className="muted small">
        Metadata steers every storyline and becomes automatic audience/tone consistency marks when canon is extracted.
      </p>
    </section>
  );
}

export function CanonSection({
  story,
  config,
  run,
}: {
  story: Story;
  config: AppConfig;
  run: Run;
}) {
  const [registry, setRegistry] = useState<CanonRegistry | null>(null);
  const [model, setModel] = useState(config.dissect.defaultModel);
  const [viewVersion, setViewVersion] = useState<number | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const reload = useCallback(async () => {
    const res = await run(() => api.getCanon(story.id));
    if (res) {
      setRegistry(res.registry);
      setViewVersion(res.registry?.currentVersion ?? null);
    }
  }, [run, story.id]);

  useEffect(() => {
    reload();
  }, [reload]);

  const version: CanonVersion | null =
    registry?.versions.find((v) => v.version === (viewVersion ?? registry.currentVersion)) ?? null;
  const isCurrent = version != null && registry != null && version.version === registry.currentVersion;

  return (
    <section className="card canon">
      <div className="card-head">
        <h3>🔒 Canon registry {registry ? `— v${registry.currentVersion}` : ''}</h3>
        <div className="row">
          <select value={model} onChange={(e) => setModel(e.target.value)} title="Dissection model">
            {config.dissect.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <button
            className="primary"
            onClick={async () => {
              const res = await run(() => api.extractCanon(story.id, { model }));
              if (res) {
                setRegistry(res.registry);
                setViewVersion(res.registry.currentVersion);
              }
            }}
          >
            {registry ? '↻ Re-extract from bible' : '✨ Extract canon from bible'}
          </button>
        </div>
      </div>

      {!registry && (
        <p className="muted">
          No canon yet. Dissect the story bible into version-controlled consistency marks — characters, relationships,
          locations, world rules, style, and audience/tone. Storylines are then generated and checked against them.
        </p>
      )}

      {registry && version && (
        <>
          <div className="row canon-toolbar">
            <label className="field inline">
              <span>Version</span>
              <select value={version.version} onChange={(e) => setViewVersion(Number(e.target.value))}>
                {[...registry.versions].reverse().map((v) => (
                  <option key={v.version} value={v.version}>
                    v{v.version} — {v.source}
                    {v.version === registry.currentVersion ? ' (current)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <span className="muted small">
              {new Date(version.createdAt).toLocaleString()} · {version.model ?? 'manual'} · {version.note}
            </span>
            <button className="ghost" onClick={() => setShowHistory((s) => !s)}>
              {showHistory ? 'Hide history' : `History (${registry.versions.length})`}
            </button>
          </div>

          {showHistory && (
            <ul className="canon-history">
              {[...registry.versions].reverse().map((v) => (
                <li key={v.version}>
                  <b>v{v.version}</b> <span className={`badge src-${v.source}`}>{v.source}</span> {v.note}{' '}
                  <span className="muted small">({new Date(v.createdAt).toLocaleString()})</span>
                </li>
              ))}
            </ul>
          )}

          {!isCurrent && <p className="muted small">Viewing a historical version (read-only).</p>}

          <div className="canon-entities">
            {version.entities.map((entity) => (
              <details key={entity.id} className="canon-entity" open={entity.type === 'character'}>
                <summary>
                  <span className="canon-icon">{TYPE_ICONS[entity.type] ?? '•'}</span>
                  <b>{entity.name}</b>
                  <span className="muted small"> {entity.id}</span>
                  <span className="muted small canon-count">{entity.marks.length} marks</span>
                </summary>
                {entity.summary && <p className="muted small">{entity.summary}</p>}
                <table className="marks">
                  <tbody>
                    {entity.marks.map((mark) => (
                      <tr key={mark.key} className={mark.status === 'transitioning' ? 'transitioning' : ''}>
                        <td className="mark-key">{mark.key}</td>
                        <td>
                          {mark.status === 'transitioning' && mark.transition ? (
                            <>
                              <s className="muted">{mark.transition.from}</s> → <b>{mark.transition.to}</b>{' '}
                              <span className="badge warn">transitioning</span>
                            </>
                          ) : (
                            mark.value
                          )}
                        </td>
                        <td>
                          <span className={`badge sev-${mark.severity}`}>{mark.severity}</span>
                        </td>
                        {isCurrent && (
                          <td className="mark-actions">
                            {mark.status === 'transitioning' ? (
                              <button
                                className="ghost small-btn"
                                title="Adopt the new value as canon"
                                onClick={async () => {
                                  await run(() => api.patchMark(story.id, entity.id, mark.key, { status: 'active' }));
                                  reload();
                                }}
                              >
                                ✓ Complete
                              </button>
                            ) : (
                              <button
                                className="ghost small-btn"
                                title="Edit this mark's value (creates a new canon version)"
                                onClick={async () => {
                                  const value = prompt(`New canonical value for "${mark.key}":`, mark.value);
                                  if (value != null && value.trim() && value !== mark.value) {
                                    await run(() => api.patchMark(story.id, entity.id, mark.key, { value }));
                                    reload();
                                  }
                                }}
                              >
                                ✎
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            ))}
          </div>

          {version.negativePrompt && (
            <p className="muted small">
              <b>Global negative prompt:</b> {version.negativePrompt}
            </p>
          )}
        </>
      )}
    </section>
  );
}
