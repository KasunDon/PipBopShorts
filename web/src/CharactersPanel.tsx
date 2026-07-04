import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { IconCheck, IconEye, IconImage, IconPaperclip, IconRefresh, IconWand, IconX, IconZoom } from './Icons';
import { Lightbox, type LightboxMedia } from './Lightbox';
import type { CharacterAsset, CharacterRegistry, PortraitVersion, ReferenceAssetType, ReferenceDefinition, Story } from './types';
import { formatElapsed, useAsyncAction } from './useAsyncAction';

type Run = <T>(fn: () => Promise<T>) => Promise<T | undefined>;
type OpenPreview = (media: LightboxMedia) => void;

function fileToBase64(file: File): Promise<{ dataBase64: string; contentType: string; filename: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ dataBase64: String(reader.result).split(',')[1] ?? '', contentType: file.type || 'image/png', filename: file.name });
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function PortraitVideo({ v, onPreview, caption }: { v: PortraitVersion; onPreview: OpenPreview; caption?: string }) {
  const cap = [caption, v.prompt].filter(Boolean).join(' — ');
  if (v.status !== 'ready') {
    return <div className={`portrait placeholder ${v.status}`}>{v.status === 'generating' ? 'Rendering…' : v.status}</div>;
  }
  if (v.videoId != null && v.previewUrl) {
    return (
      <button className="portrait-btn" title="Click to enlarge" onClick={() => onPreview({ url: v.previewUrl!, kind: 'video', caption: cap })}>
        <video className="portrait" src={v.previewUrl} muted loop playsInline />
        <span className="portrait-zoom"><IconZoom /> Enlarge</span>
      </button>
    );
  }
  if (v.previewUrl) {
    return (
      <button className="portrait-btn" title="Click to enlarge" onClick={() => onPreview({ url: v.previewUrl!, kind: 'image', caption: cap })}>
        <img className="portrait" src={v.previewUrl} alt="reference" />
        <span className="portrait-zoom"><IconZoom /> Enlarge</span>
      </button>
    );
  }
  return <div className="portrait placeholder">no preview</div>;
}

/** The still image PixVerse can consume as an image-to-video source — opens in the in-app lightbox. */
function StillThumb({ v, onPreview, caption }: { v: PortraitVersion; onPreview: OpenPreview; caption?: string }) {
  if (v.imageUrl) {
    return (
      <button className="still-thumb" onClick={() => onPreview({ url: v.imageUrl!, kind: 'image', caption: [caption, 'captured still'].filter(Boolean).join(' — ') })} title="Preview the still image">
        <img src={v.imageUrl} alt="captured still" />
        <span className="muted small">Still image</span>
      </button>
    );
  }
  if (v.status === 'generating') return null;
  if (v.status === 'ready' && v.imageError) {
    return (
      <div className="still-thumb missing" title={v.imageError}>
        <span className="muted small">No still — {v.imageError}</span>
      </div>
    );
  }
  return null;
}

function SeedThumb({ url, onPreview }: { url: string; onPreview: OpenPreview }) {
  return (
    <button className="still-thumb seed" onClick={() => onPreview({ url, kind: 'image', caption: 'Seed image' })} title="Preview the seed image">
      <img src={url} alt="seed" />
      <span className="muted small">Seed image</span>
    </button>
  );
}

export function CharactersPanel({ story, run }: { story: Story; run: Run }) {
  const [registry, setRegistry] = useState<CharacterRegistry | null>(null);
  const [lightbox, setLightbox] = useState<LightboxMedia | null>(null);
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const openPreview = useCallback((media: LightboxMedia) => setLightbox(media), []);

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
  const missing = all.filter((a) => !a.approvedVersionId);

  const renderAllMissing = async () => {
    if (missing.length === 0) return;
    if (
      !confirm(
        `Render reference images for ${missing.length} item(s) without an approved reference (${missing
          .map((m) => m.name)
          .join(', ')})?\n\nThis sends ${missing.length} generation(s) to PixVerse and uses credits. Already-approved references are skipped.`,
      )
    )
      return;
    setBulk({ done: 0, total: missing.length });
    try {
      for (let i = 0; i < missing.length; i++) {
        await run(() => api.generatePortrait(story.id, missing[i].entityId, {}));
        setBulk({ done: i + 1, total: missing.length });
        await reload();
      }
    } finally {
      setBulk(null);
    }
  };

  return (
    <section className="card">
      {lightbox && <Lightbox media={lightbox} onClose={() => setLightbox(null)} />}
      <div className="card-head">
        <h3>Reference images</h3>
        <div className="row">
          {missing.length > 0 && (
            <button className="primary" disabled={bulk !== null} onClick={renderAllMissing} title="Generate references for everything not yet approved">
              <IconWand /> {bulk ? `Rendering ${bulk.done}/${bulk.total}…` : `Render all missing (${missing.length})`}
            </button>
          )}
          <button className="ghost" onClick={reload}>
            <IconRefresh /> Sync from canon
          </button>
        </div>
      </div>
      {all.length === 0 ? (
        <p className="muted small">
          Extract canon first — characters and locations found in the bible appear here. Generate an approved
          reference image for each; scenes that feature them then render from the approved image so every clip stays
          on-model, and environments stay consistent between episodes.
        </p>
      ) : (
        <>
          <h4 className="reference-group-head">Characters</h4>
          {characters.length === 0 ? (
            <p className="muted small">No characters in canon yet.</p>
          ) : (
            <div className="character-grid">
              {characters.map((c) => (
                <CharacterCard key={c.entityId} story={story} asset={c} run={run} onChanged={reload} onPreview={openPreview} />
              ))}
            </div>
          )}

          <h4 className="reference-group-head">Locations and settings</h4>
          {locations.length === 0 ? (
            <p className="muted small">No recurring locations in canon yet.</p>
          ) : (
            <div className="character-grid">
              {locations.map((c) => (
                <CharacterCard key={c.entityId} story={story} asset={c} run={run} onChanged={reload} onPreview={openPreview} />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function tweakPlaceholder(type: ReferenceAssetType): string {
  return type === 'location' ? 'Tweak, e.g. "add string lights at dusk"' : 'Tweak, e.g. "add a tiny explorer hat"';
}

function CharacterCard({
  story,
  asset,
  run,
  onChanged,
  onPreview,
}: {
  story: Story;
  asset: CharacterAsset;
  run: Run;
  onChanged: () => void;
  onPreview: OpenPreview;
}) {
  const [tweak, setTweak] = useState('');
  const [tweakImage, setTweakImage] = useState<{ dataBase64: string; contentType: string; filename: string } | null>(null);
  const [showVersions, setShowVersions] = useState(false);
  const [def, setDef] = useState<ReferenceDefinition | null>(null);
  const [editPrompt, setEditPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const gen = useAsyncAction({ timeoutMs: 5 * 60 * 1000 });
  const approved = asset.versions.find((v) => v.id === asset.approvedVersionId) ?? null;
  const latest = asset.versions[asset.versions.length - 1] ?? null;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await run(fn);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const generate = (opts: Parameters<typeof api.generatePortrait>[2], confirmMsg: string) => {
    if (!confirm(confirmMsg)) return Promise.resolve(undefined);
    return gen.execute(async (signal) => {
      await api.generatePortrait(story.id, asset.entityId, { ...opts, signal });
      onChanged();
      return true;
    });
  };

  const toggleDefinition = async () => {
    if (def) {
      setDef(null);
      return;
    }
    const res = await run(() => api.getReferenceDefinition(story.id, asset.entityId));
    if (res) {
      setDef(res.definition);
      setEditPrompt(res.definition.currentPrompt ?? res.definition.builtPrompt);
    }
  };

  const anyBusy = busy || gen.pending;
  const showcase = approved ?? latest;
  const kindNoun = asset.type === 'location' ? 'location' : 'character';

  return (
    <div className="character-card">
      <div className="character-head">
        <b>{asset.name}</b>
        {approved ? <span className="badge live">approved</span> : <span className="badge warn">no reference</span>}
        <span className="muted small">{asset.entityId}</span>
      </div>

      {showcase ? (
        <PortraitVideo v={showcase} onPreview={onPreview} caption={asset.name} />
      ) : (
        <div className="portrait placeholder">No render yet</div>
      )}
      <div className="thumb-row">
        {showcase && <StillThumb v={showcase} onPreview={onPreview} caption={asset.name} />}
        {showcase?.sourceImageUrl && <SeedThumb url={showcase.sourceImageUrl} onPreview={onPreview} />}
      </div>

      <div className="character-actions">
        <button
          className="primary"
          disabled={anyBusy}
          onClick={() => generate({}, `Render a reference image for ${asset.name} with PixVerse? This uses credits.`)}
        >
          {asset.versions.length === 0 ? <IconWand /> : <IconRefresh />} {asset.versions.length === 0 ? 'Generate' : 'Refresh'}
        </button>
        <button className="ghost" disabled={anyBusy} onClick={toggleDefinition} title="See the canon definition and edit the render prompt">
          <IconEye /> {def ? 'Hide definition' : 'Definition'}
        </button>
        {showcase && showcase.status === 'ready' && showcase.id !== asset.approvedVersionId && (
          <button disabled={anyBusy} onClick={() => act(() => api.approvePortrait(story.id, asset.entityId, showcase.id))}>
            <IconCheck /> Approve
          </button>
        )}
        {showcase && showcase.status === 'generating' && (
          <button disabled={anyBusy} onClick={() => act(() => api.refreshPortrait(story.id, asset.entityId, showcase.id))}>
            <IconRefresh /> Poll
          </button>
        )}
        <label className="upload">
          <IconImage /> Upload still
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

      {def && (
        <div className="definition-box">
          <p className="muted small">{def.summary}</p>
          <ul className="mark-list">
            {def.marks.map((m) => (
              <li key={m.key}>
                <span className={`badge sev-${m.severity}`}>{m.severity}</span> <b>{m.key}:</b> {m.value}
              </li>
            ))}
          </ul>
          <label className="field">
            <span>Render prompt (edit before generating)</span>
            <textarea value={editPrompt} onChange={(e) => setEditPrompt(e.target.value)} rows={5} disabled={anyBusy} />
          </label>
          <div className="row">
            <button className="ghost small" disabled={anyBusy} onClick={() => setEditPrompt(def.builtPrompt)} title="Reset to the canon-built prompt">
              Reset to canon prompt
            </button>
            <button
              className="primary"
              disabled={anyBusy || !editPrompt.trim()}
              onClick={() =>
                generate(
                  { source: 'tweak', promptOverride: editPrompt.trim() },
                  `Render ${asset.name} from your edited prompt? This uses PixVerse credits.`,
                )
              }
            >
              <IconWand /> Generate from this prompt
            </button>
          </div>
        </div>
      )}

      {gen.pending && (
        <div className="row idea-progress">
          <span className="muted small">Rendering… {formatElapsed(gen.elapsedSec)} elapsed</span>
          <button className="ghost small" onClick={gen.cancel}>
            <IconX /> Cancel
          </button>
        </div>
      )}
      {gen.error && (
        <div className="error inline" role="alert">
          {gen.error}
          <button onClick={gen.dismissError}>×</button>
        </div>
      )}

      <div className="tweak-box">
        <input
          className="tweak-input"
          placeholder={tweakPlaceholder(asset.type)}
          value={tweak}
          onChange={(e) => setTweak(e.target.value)}
          disabled={anyBusy}
        />
        <div className="tweak-attach">
          <label className="upload small" title="Attach an image to guide the render (image-to-video)">
            <IconPaperclip /> {tweakImage ? 'Change image' : 'Attach image'}
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
                <IconX />
              </button>
            </span>
          )}
          <button
            disabled={anyBusy || (!tweak.trim() && !tweakImage)}
            title="Regenerate from the current prompt plus your adjustment (and attached image, if any)"
            onClick={async () => {
              const base = (approved ?? latest)?.prompt ?? '';
              const adjust = tweak.trim();
              const promptOverride = adjust ? (base ? `${base}\n\nAdjustment: ${adjust}` : adjust) : base;
              const res = await generate(
                {
                  source: 'tweak',
                  promptOverride,
                  dataBase64: tweakImage?.dataBase64,
                  contentType: tweakImage?.contentType,
                  filename: tweakImage?.filename,
                },
                `Re-render ${kindNoun} ${asset.name} with your tweak? This uses PixVerse credits.`,
              );
              if (res !== undefined) {
                setTweak('');
                setTweakImage(null);
              }
            }}
          >
            Tweak &amp; regenerate
          </button>
        </div>
        {tweakImage && <p className="muted small">The attached image will seed an image-to-video render, anchoring the result to it.</p>}
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
              <PortraitVideo v={v} onPreview={onPreview} caption={`${asset.name} v${v.version}`} />
              <StillThumb v={v} onPreview={onPreview} caption={`${asset.name} v${v.version}`} />
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
