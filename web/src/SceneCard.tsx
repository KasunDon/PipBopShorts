import { useEffect, useState } from 'react';
import { api } from './api';
import { Field } from './App';
import { IconAlert, IconCheck, IconExpand, IconImage, IconPlay, IconRefresh } from './Icons';
import type { AppConfig, Clip, Project, QcResult, ReferenceReadinessItem, Scene } from './types';

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
  onMove,
  references = [],
}: {
  index: number;
  total: number;
  scene: Scene;
  clip: Clip | undefined;
  config: AppConfig;
  storylineId: string;
  setProject: (p: Project) => void;
  run: Run;
  onMove?: (dir: -1 | 1) => void;
  references?: ReferenceReadinessItem[];
}) {
  const [draft, setDraft] = useState<Scene>(scene);
  const [dirty, setDirty] = useState(false);
  const [patchReq, setPatchReq] = useState('');
  const [patching, setPatching] = useState(false);
  const [showPatchLog, setShowPatchLog] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [qc, setQc] = useState<QcResult | null>(null);
  const [qcing, setQcing] = useState(false);

  useEffect(() => {
    setDraft(scene);
    setDirty(false);
  }, [scene]);

  const applyPatch = async () => {
    if (!patchReq.trim()) return;
    setPatching(true);
    try {
      const res = await run(() => api.patchScene(storylineId, scene.id, patchReq.trim()));
      if (res) {
        setProject(res.project);
        setPatchReq('');
      }
    } finally {
      setPatching(false);
    }
  };

  const addComment = async () => {
    if (!commentText.trim()) return;
    const res = await run(() => api.addComment(storylineId, scene.id, commentText.trim()));
    if (res) {
      setProject(res.project);
      setCommentText('');
    }
  };

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
        caption: draft.caption ?? '',
        seed: draft.seed,
        lighting: draft.lighting ?? '',
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
        {onMove && (
          <div className="scene-move">
            <button className="ghost small" title="Move up" disabled={index === 0} onClick={() => onMove(-1)}>
              ↑
            </button>
            <button className="ghost small" title="Move down" disabled={index === total - 1} onClick={() => onMove(1)}>
              ↓
            </button>
          </div>
        )}
        <input className="scene-heading" value={draft.heading} onChange={(e) => update('heading', e.target.value)} />
        <span className={`status status-${status}`}>{STATUS_LABELS[status]}</span>
      </div>

      <div className="scene-body">
        <div className="scene-left">
          <Field label="Prompt (what PixVerse renders)">
            <textarea value={draft.prompt} onChange={(e) => update('prompt', e.target.value)} rows={4} />
          </Field>
          <Field label="Caption (sound-off subtitle)">
            <input value={draft.caption ?? ''} onChange={(e) => update('caption', e.target.value)} placeholder="On-screen caption…" />
          </Field>
          <div className="grid grid-3">
            <Field label="Lighting">
              <input value={draft.lighting ?? ''} onChange={(e) => update('lighting', e.target.value)} placeholder="e.g. golden hour" />
            </Field>
            <Field label="Seed (blank = random)">
              <input
                type="number"
                min={0}
                value={draft.seed ?? ''}
                onChange={(e) => update('seed', e.target.value === '' ? (undefined as unknown as number) : Number(e.target.value))}
                placeholder="reproducible seed"
              />
            </Field>
          </div>

          <div className="scene-patch">
            <input
              value={patchReq}
              onChange={(e) => setPatchReq(e.target.value)}
              placeholder='Directed edit — change one thing (e.g. "make the hero look worried")'
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyPatch();
              }}
            />
            <button
              className="small"
              disabled={patching || !patchReq.trim()}
              onClick={applyPatch}
              title="Change only this and preserve everything else (locked by default)"
            >
              {patching ? 'Editing…' : 'Apply edit'}
            </button>
            <button
              className="small ghost"
              disabled={patching}
              title="Full creative re-write of this shot (a fresh take on the same beat)"
              onClick={async () => {
                const guidance = prompt('Fresh take — any direction? (optional)') ?? '';
                setPatching(true);
                try {
                  const res = await run(() => api.regenerateScene(storylineId, scene.id, guidance));
                  if (res) setProject(res.project);
                } finally {
                  setPatching(false);
                }
              }}
            >
              Fresh take
            </button>
            {scene.patchHistory && scene.patchHistory.length > 0 && (
              <button className="small ghost" onClick={() => setShowPatchLog((s) => !s)}>
                {showPatchLog ? 'Hide edits' : `Edits (${scene.patchHistory.length})`}
              </button>
            )}
          </div>
          {showPatchLog && scene.patchHistory && (
            <ul className="patch-log">
              {[...scene.patchHistory].reverse().map((p) => (
                <li key={p.id}>
                  <span className="patch-req">“{p.request}”</span>
                  <span className="muted small"> — {p.changed}</span>
                  {p.preserved.length > 0 && (
                    <span className="muted small"> · kept: {p.preserved.join(', ')}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
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
            {status === 'ready' && (
              <button
                className={clip?.approved ? 'ghost' : 'primary'}
                title={clip?.approved ? 'This clip is approved for publishing' : 'Approve this clip for publishing'}
                onClick={async () => {
                  await run(() => api.approveClip(storylineId, scene.id, !clip?.approved));
                  const p = await api.getProject(storylineId);
                  setProject(p.project);
                }}
              >
                <IconCheck /> {clip?.approved ? 'Approved' : 'Approve'}
              </button>
            )}
            {status === 'ready' && (
              <button
                className="ghost"
                disabled={qcing}
                title="Check this shot's prompt against the canon it references"
                onClick={async () => {
                  setQcing(true);
                  try {
                    const res = await run(() => api.qcScene(storylineId, scene.id));
                    if (res) setQc(res.qc);
                  } finally {
                    setQcing(false);
                  }
                }}
              >
                {qcing ? 'Checking…' : 'QC'}
              </button>
            )}
            <button
              disabled={status === 'generating'}
              title={status === 'generating' ? 'Already rendering — you will be notified when it finishes' : undefined}
              onClick={async () => {
                if (
                  !confirm(
                    `${status === 'ready' ? 'Re-render' : 'Render'} scene #${index + 1}? This uses credits.\n\nThe render runs in the background — you'll be notified when it's ready, even if you navigate away.`,
                  )
                )
                  return;
                const res = await run(() => api.generateScene(storylineId, scene.id, false));
                if (res) {
                  const p = await api.getProject(storylineId);
                  setProject(p.project);
                }
              }}
            >
              {status === 'ready' ? <IconRefresh /> : <IconPlay />} {status === 'ready' ? 'Re-render' : 'Render'}
            </button>
            {status === 'generating' && (
              <button
                onClick={async () => {
                  await run(() => api.refreshScene(storylineId, scene.id));
                  const p = await api.getProject(storylineId);
                  setProject(p.project);
                }}
              >
                <IconRefresh /> Poll
              </button>
            )}
            {status === 'ready' && (
              <button
                onClick={async () => {
                  if (
                    !confirm(
                      `Extend scene #${index + 1}? This renders a continuation and uses credits.\n\nThe render runs in the background — you'll be notified when it's ready.`,
                    )
                  )
                    return;
                  await run(() => api.extendScene(storylineId, scene.id, false));
                  const p = await api.getProject(storylineId);
                  setProject(p.project);
                }}
              >
                <IconExpand /> Extend
              </button>
            )}
            <label className="upload">
              <IconImage /> Reference image
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
            <button
              className="ghost"
              title="Duplicate this scene (creates a variation right after)"
              onClick={async () => {
                const res = await run(() => api.duplicateScene(storylineId, scene.id));
                if (res) setProject(res.project);
              }}
            >
              Duplicate
            </button>
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
          {references.length > 0 ? (
            <div className="scene-refs">
              <span className="muted small">References (click to set the image seed):</span>
              {references.map((r) => {
                const isPrimary =
                  scene.primaryReferenceId === r.entityId ||
                  (!scene.primaryReferenceId && references.find((x) => x.approved)?.entityId === r.entityId);
                return (
                  <button
                    key={r.entityId}
                    className={`ref-chip ${r.approved ? 'ok' : 'warn'} ${isPrimary && r.approved ? 'primary-ref' : ''}`}
                    title={
                      r.approved
                        ? isPrimary
                          ? "This reference's image seeds the render"
                          : "Use this reference's image as the render seed"
                        : 'No approved reference — will render text-only'
                    }
                    disabled={!r.approved}
                    onClick={async () => {
                      const res = await run(() => api.updateScene(storylineId, scene.id, { primaryReferenceId: r.entityId }));
                      if (res) setProject(res.project);
                    }}
                  >
                    {r.approved ? <IconCheck /> : <IconAlert />}
                    {r.name}
                    <span className="ref-type">{r.type}</span>
                    {isPrimary && r.approved && <span className="ref-type">seed</span>}
                  </button>
                );
              })}
            </div>
          ) : (
            scene.referenceCharacterIds &&
            scene.referenceCharacterIds.length > 0 && (
              <p className="muted small">Character references: {scene.referenceCharacterIds.length}.</p>
            )
          )}
          {scene.imageUrl && <p className="muted small">Reference image attached (image-to-video). Camera movement will apply.</p>}
          {clip?.error && <p className="scene-error">{clip.error}</p>}

          {qc && (
            <div className="qc-box">
              <div className="qc-head">
                <b>Continuity QC</b>
                <span className="muted small">
                  {qc.passed} pass · {qc.warnings} warn · {qc.failures} fail
                </span>
                <button className="comment-del" onClick={() => setQc(null)} aria-label="Dismiss">×</button>
              </div>
              {qc.checks.filter((c) => c.verdict !== 'pass').length === 0 ? (
                <p className="muted small">All referenced canon marks are honoured by the prompt.</p>
              ) : (
                <ul className="qc-list">
                  {qc.checks
                    .filter((c) => c.verdict !== 'pass')
                    .map((c, i) => (
                      <li key={i} className={`qc-${c.verdict}`}>
                        <span className="qc-verdict">{c.verdict}</span>
                        <b>{c.entityName}</b> · {c.markKey}
                        {c.note && <span className="muted small"> — {c.note}</span>}
                      </li>
                    ))}
                </ul>
              )}
            </div>
          )}

          <div className="scene-comments">
            {scene.comments && scene.comments.length > 0 && (
              <ul className="comment-list">
                {scene.comments.map((c) => (
                  <li key={c.id} className={`comment ${c.resolved ? 'resolved' : ''}`}>
                    <button
                      className="comment-check"
                      title={c.resolved ? 'Mark unresolved' : 'Mark resolved'}
                      onClick={async () => {
                        const res = await run(() => api.resolveComment(storylineId, scene.id, c.id, !c.resolved));
                        if (res) setProject(res.project);
                      }}
                    >
                      {c.resolved ? <IconCheck /> : <span className="comment-dot" />}
                    </button>
                    <span className="comment-text">{c.text}</span>
                    <button
                      className="comment-del"
                      title="Delete note"
                      onClick={async () => {
                        const res = await run(() => api.deleteComment(storylineId, scene.id, c.id));
                        if (res) setProject(res.project);
                      }}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="comment-add">
              <input
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                placeholder="Add a review note…"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addComment();
                }}
              />
              <button className="small ghost" disabled={!commentText.trim()} onClick={addComment}>
                Note
              </button>
            </div>
          </div>
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
