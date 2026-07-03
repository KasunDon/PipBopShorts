import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { CharacterAsset, CharacterRegistry, PortraitVersion, Story } from './types';

type Run = <T>(fn: () => Promise<T>) => Promise<T | undefined>;

function fileToBase64(file: File): Promise<{ dataBase64: string; contentType: string; filename: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ dataBase64: String(reader.result).split(',')[1] ?? '', contentType: file.type || 'image/png', filename: file.name });
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function PortraitMedia({ v }: { v: PortraitVersion }) {
  if (v.status !== 'ready') {
    return <div className={`portrait placeholder ${v.status}`}>{v.status === 'generating' ? 'Rendering…' : v.status}</div>;
  }
  if (v.videoId != null && v.previewUrl) {
    return <video className="portrait" src={v.previewUrl} controls muted loop playsInline />;
  }
  if (v.previewUrl) return <img className="portrait" src={v.previewUrl} alt="reference" />;
  return <div className="portrait placeholder">no preview</div>;
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

  const characters = registry ? Object.values(registry.characters) : [];

  return (
    <section className="card">
      <div className="card-head">
        <h3>🧸 Character reference images</h3>
        <button className="ghost" onClick={reload}>
          ↻ Sync from canon
        </button>
      </div>
      {characters.length === 0 ? (
        <p className="muted small">
          Extract canon first — characters found in the bible appear here. Generate an approved reference image per
          character; scenes that feature them then render from the approved image so every clip stays on-model.
        </p>
      ) : (
        <div className="character-grid">
          {characters.map((c) => (
            <CharacterCard key={c.entityId} story={story} asset={c} run={run} onChanged={reload} />
          ))}
        </div>
      )}
    </section>
  );
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
  const [showVersions, setShowVersions] = useState(false);
  const [busy, setBusy] = useState(false);
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

  const showcase = approved ?? latest;

  return (
    <div className="character-card">
      <div className="character-head">
        <b>{asset.name}</b>
        {approved ? <span className="badge live">approved</span> : <span className="badge warn">no reference</span>}
        <span className="muted small">{asset.entityId}</span>
      </div>

      {showcase ? <PortraitMedia v={showcase} /> : <div className="portrait placeholder">No portrait yet</div>}

      <div className="character-actions">
        <button className="primary" disabled={busy} onClick={() => act(() => api.generatePortrait(story.id, asset.entityId, {}))}>
          {asset.versions.length === 0 ? '✨ Generate' : '↻ Refresh'}
        </button>
        {showcase && showcase.status === 'ready' && showcase.id !== asset.approvedVersionId && (
          <button disabled={busy} onClick={() => act(() => api.approvePortrait(story.id, asset.entityId, showcase.id))}>
            ✓ Approve
          </button>
        )}
        {showcase && showcase.status === 'generating' && (
          <button disabled={busy} onClick={() => act(() => api.refreshPortrait(story.id, asset.entityId, showcase.id))}>
            ⟳ Poll
          </button>
        )}
        <label className="upload">
          🖼 Upload still
          <input
            type="file"
            accept="image/*"
            disabled={busy}
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

      <div className="tweak-row">
        <input
          placeholder="✨ Tweak prompt (e.g. add a tiny hat)…"
          value={tweak}
          onChange={(e) => setTweak(e.target.value)}
          disabled={busy}
        />
        <button
          disabled={busy || !tweak.trim()}
          onClick={async () => {
            const base = (approved ?? latest)?.prompt ?? '';
            const promptOverride = base ? `${base}\n\nAdjustment: ${tweak.trim()}` : tweak.trim();
            await act(() => api.generatePortrait(story.id, asset.entityId, { source: 'tweak', promptOverride }));
            setTweak('');
          }}
        >
          Tweak &amp; regenerate
        </button>
      </div>

      {showcase?.imageId == null && approved && (
        <p className="muted small">
          Approved as a visual spec (descriptors injected into scenes). Upload a still to also send an actual image to
          PixVerse for image-to-video.
        </p>
      )}

      {asset.versions.length > 0 && (
        <button className="link" onClick={() => setShowVersions((s) => !s)}>
          {showVersions ? 'Hide' : `Versions (${asset.versions.length})`}
        </button>
      )}
      {showVersions && (
        <div className="version-strip">
          {[...asset.versions].reverse().map((v) => (
            <div key={v.id} className={`version-thumb ${v.id === asset.approvedVersionId ? 'approved' : ''}`}>
              <PortraitMedia v={v} />
              <div className="muted small">
                v{v.version} · {v.source}
              </div>
              {v.status === 'ready' && v.id !== asset.approvedVersionId && (
                <button className="small-btn" disabled={busy} onClick={() => act(() => api.approvePortrait(story.id, asset.entityId, v.id))}>
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
