import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { CharacterAsset, CharacterRegistry, PortraitVersion, ReferenceAssetType, Story } from './types';
import { formatElapsed, useAsyncAction } from './useAsyncAction';

type Run = <T>(fn: () => Promise<T>) => Promise<T | undefined>;

function fileToBase64(file: File): Promise<{ dataBase64: string; contentType: string; filename: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ dataBase64: String(reader.result).split(',')[1] ?? '', contentType: file.type || 'image/png', filename: file.name });
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function PortraitVideo({ v }: { v: PortraitVersion }) {
  if (v.status !== 'ready') {
    return <div className={`portrait placeholder ${v.status}`}>{v.status === 'generating' ? 'Rendering…' : v.status}</div>;
  }
  if (v.videoId != null && v.previewUrl) {
    return <video className="portrait" src={v.previewUrl} controls muted loop playsInline />;
  }
  if (v.previewUrl) return <img className="portrait" src={v.previewUrl} alt="reference" />;
  return <div className="portrait placeholder">no preview</div>;
}

/** The still image PixVerse can actually use as an image-to-video source — shown distinctly from the video preview. */
function StillThumb({ v }: { v: PortraitVersion }) {
  if (v.imageUrl) {
    return (
      <a className="still-thumb" href={v.imageUrl} target="_blank" rel="noreferrer" title="Open the captured still image">
        <img src={v.imageUrl} alt="captured still" />
        <span className="muted small">🖼 still image</span>
      </a>
    );
  }
  if (v.status === 'generating') return null;
  if (v.status === 'ready' && v.imageError) {
    return (
      <div className="still-thumb missing" title={v.imageError}>
        <span className="muted small">🖼 no still — {v.imageError}</span>
      </div>
    );
  }
  return null;
}

/** Shows the input image a render was seeded from (image-guided tweak). */
function SeedThumb({ url }: { url: string }) {
  return (
    <a className="still-thumb seed" href={url} target="_blank" rel="noreferrer" title="Seeded from this attached image">
      <img src={url} alt="seed" />
      <span className="muted small">📎 seeded from</span>
    </a>
  );
}

export function CharactersPanel({ story, run }: { story: Story; run: Run }) {
  const [registry, setRegistry] = useState<CharacterRegistry | null>(null);

  const reload = useCallback(async () => {
    const res = await run(() => api.getCharacters(story.id));
    if (res) setRegistry(res.registry);
  }, [run, story.id]);

  useEffect(() => {
    reload();
  }, [reload]);

  const all = registry ? Object.values(registry.characters) : [];
  const characters = all.filter((a) => a.type !== 'location');
  const locations = all.filter((a) => a.type === 'location');

  return (
    <section className="card">
      <div className="card-head">
        <h3>🧸🏞 Reference images</h3>
        <button className="ghost" onClick={reload}>
          ↻ Sync from canon
        </button>
      </div>
      {all.length === 0 ? (
        <p className="muted small">
          Extract canon first — characters and locations found in the bible appear here. Generate an approved
          reference image for each; scenes that feature them then render from the approved image so every clip stays
          on-model, and environments stay consistent between episodes.
        </p>
      ) : (
        <>
          <h4 className="reference-group-head">🧸 Characters</h4>
          {characters.length === 0 ? (
            <p className="muted small">No characters in canon yet.</p>
          ) : (
            <div className="character-grid">
              {characters.map((c) => (
                <CharacterCard key={c.entityId} story={story} asset={c} run={run} onChanged={reload} />
              ))}
            </div>
          )}

          <h4 className="reference-group-head">🏞 Locations &amp; settings</h4>
          {locations.length === 0 ? (
            <p className="muted small">No recurring locations in canon yet.</p>
          ) : (
            <div className="character-grid">
              {locations.map((c) => (
                <CharacterCard key={c.entityId} story={story} asset={c} run={run} onChanged={reload} />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function tweakPlaceholder(type: ReferenceAssetType): string {
  return type === 'location' ? '✨ Tweak prompt (e.g. add string lights at dusk)…' : '✨ Tweak prompt (e.g. add a tiny hat)…';
}

function CharacterCard({
  story,
  asset,
  run,
  onChanged,
}: {
  story: Story;
  asset: CharacterAsset;
  run: Run;
  onChanged: () => void;
}) {
  const [tweak, setTweak] = useState('');
  const [tweakImage, setTweakImage] = useState<{ dataBase64: string; contentType: string; filename: string } | null>(null);
  const [showVersions, setShowVersions] = useState(false);
  const [busy, setBusy] = useState(false);
  const gen = useAsyncAction({ timeoutMs: 5 * 60 * 1000 });
  const approved = asset.versions.find((v) => v.id === asset.approvedVersionId) ?? null;
  const latest = asset.versions[asset.versions.length - 1] ?? null;

  // Fast, synchronous-ish actions (approve/upload) keep the simple pattern.
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await run(fn);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  // Slow render actions get elapsed feedback + cancel + retry-friendly errors.
  const generate = (opts: Parameters<typeof api.generatePortrait>[2]) =>
    gen.execute(async (signal) => {
      await api.generatePortrait(story.id, asset.entityId, { ...opts, signal });
      onChanged();
      return true;
    });

  const anyBusy = busy || gen.pending;
  const showcase = approved ?? latest;

  return (
    <div className="character-card">
      <div className="character-head">
        <b>{asset.name}</b>
        {approved ? <span className="badge live">approved</span> : <span className="badge warn">no reference</span>}
        <span className="muted small">{asset.entityId}</span>
      </div>

      {showcase ? <PortraitVideo v={showcase} /> : <div className="portrait placeholder">No render yet</div>}
      <div className="thumb-row">
        {showcase && <StillThumb v={showcase} />}
        {showcase?.sourceImageUrl && <SeedThumb url={showcase.sourceImageUrl} />}
      </div>

      <div className="character-actions">
        <button className="primary" disabled={anyBusy} onClick={() => generate({})}>
          {asset.versions.length === 0 ? '✨ Generate' : '↻ Refresh'}
        </button>
        {showcase && showcase.status === 'ready' && showcase.id !== asset.approvedVersionId && (
          <button disabled={anyBusy} onClick={() => act(() => api.approvePortrait(story.id, asset.entityId, showcase.id))}>
            ✓ Approve
          </button>
        )}
        {showcase && showcase.status === 'generating' && (
          <button disabled={anyBusy} onClick={() => act(() => api.refreshPortrait(story.id, asset.entityId, showcase.id))}>
            ⟳ Poll
          </button>
        )}
        <label className="upload">
          🖼 Upload still
          <input
            type="file"
            accept="image/*"
            disabled={anyBusy}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const payload = await fileToBase64(file);
              await act(() => api.uploadStill(story.id, asset.entityId, payload));
              e.target.value = '';
            }}
          />
        </label>
      </div>

      {gen.pending && (
        <div className="row idea-progress">
          <span className="muted small">✨ Rendering… {formatElapsed(gen.elapsedSec)} elapsed</span>
          <button className="ghost small" onClick={gen.cancel}>
            ✕ Cancel
          </button>
        </div>
      )}
      {gen.error && (
        <div className="error inline" role="alert">
          {gen.error}
          <div className="row">
            <button className="ghost small" onClick={() => generate({})}>
              ↻ Retry
            </button>
            <button onClick={gen.dismissError}>×</button>
          </div>
        </div>
      )}

      <div className="tweak-box">
        <div className="tweak-row">
          <input
            placeholder={tweakPlaceholder(asset.type)}
            value={tweak}
            onChange={(e) => setTweak(e.target.value)}
            disabled={anyBusy}
          />
          <button
            disabled={anyBusy || (!tweak.trim() && !tweakImage)}
            title="Regenerate from the current prompt plus your adjustment (and attached image, if any)"
            onClick={async () => {
              const base = (approved ?? latest)?.prompt ?? '';
              const adjust = tweak.trim();
              const promptOverride = adjust ? (base ? `${base}\n\nAdjustment: ${adjust}` : adjust) : base;
              const res = await generate({
                source: 'tweak',
                promptOverride,
                dataBase64: tweakImage?.dataBase64,
                contentType: tweakImage?.contentType,
                filename: tweakImage?.filename,
              });
              if (res !== undefined) {
                setTweak('');
                setTweakImage(null);
              }
            }}
          >
            Tweak &amp; regenerate
          </button>
        </div>
        <div className="tweak-attach">
          <label className="upload small" title="Attach an image to guide the render (image-to-video)">
            📎 {tweakImage ? 'Change image' : 'Attach image'}
            <input
              type="file"
              accept="image/*"
              disabled={anyBusy}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setTweakImage(await fileToBase64(file));
                e.target.value = '';
              }}
            />
          </label>
          {tweakImage && (
            <span className="muted small tweak-attach-name">
              {tweakImage.filename}
              <button className="linkish" onClick={() => setTweakImage(null)} title="Remove attached image">
                ✕
              </button>
            </span>
          )}
        </div>
        {tweakImage && (
          <p className="muted small">
            The attached image will seed an image-to-video render, keeping the result anchored to it.
          </p>
        )}
      </div>

      {asset.versions.length > 0 && (
        <button className="link" onClick={() => setShowVersions((s) => !s)}>
          {showVersions ? 'Hide' : `Versions (${asset.versions.length})`}
        </button>
      )}
      {showVersions && (
        <div className="version-strip">
          {[...asset.versions].reverse().map((v) => (
            <div key={v.id} className={`version-thumb ${v.id === asset.approvedVersionId ? 'approved' : ''}`}>
              <PortraitVideo v={v} />
              <StillThumb v={v} />
              <div className="muted small">
                v{v.version} · {v.source}
              </div>
              {v.status === 'ready' && v.id !== asset.approvedVersionId && (
                <button className="small-btn" disabled={anyBusy} onClick={() => act(() => api.approvePortrait(story.id, asset.entityId, v.id))}>
                  Approve
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
