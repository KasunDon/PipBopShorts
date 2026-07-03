import { useEffect, useState } from 'react';
import { api } from './api';
import { Field } from './App';
import type { AppConfig, Clip, Project, Scene } from './types';

function fileToBase64(file: File): Promise<{ dataBase64: string; contentType: string; filename: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const base64 = result.split(',')[1] ?? '';
      resolve({ dataBase64: base64, contentType: file.type || 'image/png', filename: file.name });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

type Run = <T>(fn: () => Promise<T>) => Promise<T | undefined>;

const STATUS_LABELS: Record<Clip['status'], string> = {
  idle: 'not rendered',
  generating: 'rendering…',
  ready: 'ready',
  failed: 'failed',
  moderation_failed: 'moderation failed',
};

export function SceneCard({
  index,
  total,
  scene,
  clip,
  config,
  storylineId,
  setProject,
  run,
}: {
  index: number;
  total: number;
  scene: Scene;
  clip: Clip | undefined;
  config: AppConfig;
  storylineId: string;
  setProject: (p: Project) => void;
  run: Run;
}) {
  const [draft, setDraft] = useState<Scene>(scene);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setDraft(scene);
    setDirty(false);
  }, [scene]);

  const update = <K extends keyof Scene>(key: K, value: Scene[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setDirty(true);
  };

  const status = clip?.status ?? 'idle';

  const save = async () => {
    const res = await run(() =>
      api.updateScene(storylineId, scene.id, {
        heading: draft.heading,
        description: draft.description,
        prompt: draft.prompt,
        negativePrompt: draft.negativePrompt,
        duration: Number(draft.duration),
        aspectRatio: draft.aspectRatio,
        model: draft.model,
        quality: draft.quality,
        motionMode: draft.motionMode,
        style: draft.style,
        cameraMovement: draft.cameraMovement,
      }),
    );
    if (res) {
      setProject(res.project);
      setDirty(false);
    }
  };

  return (
    <div className="scene-card">
      <div className="scene-head">
        <div className="scene-num">#{index + 1}</div>
        <input className="scene-heading" value={draft.heading} onChange={(e) => update('heading', e.target.value)} />
        <span className={`status status-${status}`}>{STATUS_LABELS[status]}</span>
      </div>

      <div className="scene-body">
        <div className="scene-left">
          <Field label="Prompt (what PixVerse renders)">
            <textarea value={draft.prompt} onChange={(e) => update('prompt', e.target.value)} rows={4} />
          </Field>
          <Field label="Negative prompt">
            <textarea value={draft.negativePrompt} onChange={(e) => update('negativePrompt', e.target.value)} rows={2} />
          </Field>
          <div className="grid grid-3">
            <Field label="Duration">
              <select value={draft.duration} onChange={(e) => update('duration', Number(e.target.value) as Scene['duration'])}>
                {config.pixverse.durations.map((d) => (
                  <option key={d} value={d}>
                    {d}s
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Aspect">
              <select value={draft.aspectRatio} onChange={(e) => update('aspectRatio', e.target.value)}>
                {config.pixverse.aspectRatios.map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
            </Field>
            <Field label="Model">
              <select value={draft.model} onChange={(e) => update('model', e.target.value)}>
                {config.pixverse.models.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </Field>
            <Field label="Quality">
              <select value={draft.quality} onChange={(e) => update('quality', e.target.value)}>
                {config.pixverse.qualities.map((q) => (
                  <option key={q}>{q}</option>
                ))}
              </select>
            </Field>
            <Field label="Motion">
              <select value={draft.motionMode} onChange={(e) => update('motionMode', e.target.value)}>
                {config.pixverse.motionModes.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </Field>
            <Field label="Style">
              <select value={draft.style} onChange={(e) => update('style', e.target.value)}>
                {config.pixverse.styles.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </Field>
            <Field label="Camera">
              <select value={draft.cameraMovement} onChange={(e) => update('cameraMovement', e.target.value)}>
                {config.pixverse.cameraMovements.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </Field>
          </div>

          <div className="scene-actions">
            <button className={dirty ? 'primary' : ''} onClick={save} disabled={!dirty}>
              {dirty ? 'Save changes' : 'Saved'}
            </button>
            <button
              onClick={async () => {
                const res = await run(() => api.generateScene(storylineId, scene.id, true));
                if (res) {
                  const p = await api.getProject(storylineId);
                  setProject(p.project);
                }
              }}
            >
              {status === 'ready' ? '↻ Re-render' : '▶ Render'}
            </button>
            {status === 'generating' && (
              <button
                onClick={async () => {
                  await run(() => api.refreshScene(storylineId, scene.id));
                  const p = await api.getProject(storylineId);
                  setProject(p.project);
                }}
              >
                ⟳ Refresh
              </button>
            )}
            {status === 'ready' && (
              <button
                onClick={async () => {
                  await run(() => api.extendScene(storylineId, scene.id, true));
                  const p = await api.getProject(storylineId);
                  setProject(p.project);
                }}
              >
                ⤢ Extend
              </button>
            )}
            <label className="upload">
              🖼 Reference image
              <input
                type="file"
                accept="image/*"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const payload = await fileToBase64(file);
                  const res = await run(() => api.uploadImage(storylineId, scene.id, payload));
                  if (res) setProject(res.project);
                  e.target.value = '';
                }}
              />
            </label>
            {total > 1 && (
              <button
                className="danger ghost"
                onClick={async () => {
                  if (confirm('Delete this scene?')) {
                    const res = await run(() => api.removeScene(storylineId, scene.id));
                    if (res) setProject(res.project);
                  }
                }}
              >
                Delete
              </button>
            )}
          </div>
          {scene.imageUrl && <p className="muted small">Reference image attached (image-to-video). Camera movement will apply.</p>}
          {clip?.error && <p className="scene-error">{clip.error}</p>}
        </div>

        <div className="scene-right">
          {clip?.url ? (
            <video src={clip.url} controls className="preview" playsInline />
          ) : (
            <div className={`preview placeholder ${status}`}>
              {status === 'generating' ? 'Rendering…' : status === 'idle' ? 'No preview yet' : STATUS_LABELS[status]}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
