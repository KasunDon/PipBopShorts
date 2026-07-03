import { useState } from 'react';
import { api } from './api';
import type { AppConfig, Project } from './types';

type Run = <T>(fn: () => Promise<T>) => Promise<T | undefined>;

export function DriftPanel({
  project,
  config,
  setProject,
  run,
}: {
  project: Project;
  config: AppConfig;
  setProject: (p: Project) => void;
  run: Run;
}) {
  const [model, setModel] = useState(config.dissect.defaultModel);
  const storylineId = project.storyline.id;
  const reports = [...(project.driftReports ?? [])].reverse();
  const latest = reports[0];

  const refresh = async () => {
    const res = await api.getProject(storylineId);
    setProject(res.project);
  };

  const sceneNumber = (sceneId: string): string => {
    const idx = project.storyline.scenes.findIndex((s) => s.id === sceneId);
    return idx >= 0 ? `#${idx + 1}` : '?';
  };

  return (
    <section className="card drift">
      <div className="card-head">
        <h3>
          🧭 Consistency check
          {project.storyline.canonVersion != null && (
            <span className="muted small"> (generated against canon v{project.storyline.canonVersion})</span>
          )}
        </h3>
        <div className="row">
          <select value={model} onChange={(e) => setModel(e.target.value)} title="Checker model">
            {config.dissect.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <button
            className="primary"
            onClick={async () => {
              const res = await run(() => api.driftCheck(storylineId, { model }));
              if (res) refresh();
            }}
          >
            🔍 Check against canon
          </button>
        </div>
      </div>

      {!latest && (
        <p className="muted small">
          Run a check to compare this storyline's scenes against the story's canonical consistency marks. Drifts can be
          rejected, accepted immediately, or accepted gradually.
        </p>
      )}

      {latest && (
        <div className="drift-report">
          <p className="muted small">
            Latest check: {new Date(latest.createdAt).toLocaleString()} · {latest.model} · canon v{latest.canonVersion}
            {reports.length > 1 ? ` · ${reports.length} checks total` : ''}
          </p>
          {latest.summary && <p>{latest.summary}</p>}
          {latest.findings.length === 0 && <p className="drift-clean">✅ No drift detected — storyline matches canon.</p>}

          {latest.findings.map((f) => (
            <div key={f.id} className={`finding sev-${f.severity} ${f.resolution ? 'resolved' : ''}`}>
              <div className="finding-head">
                <span className={`badge sev-${f.severity}`}>{f.severity}</span>
                <b>
                  {f.entityName} · {f.markKey}
                </b>
                {f.sceneIds.length > 0 && (
                  <span className="muted small">scenes {f.sceneIds.map(sceneNumber).join(', ')}</span>
                )}
              </div>
              <p className="small">
                <b>Canon:</b> {f.expected || '(not tracked yet)'} <br />
                <b>Storyline:</b> {f.observed}
              </p>
              <p className="muted small">{f.explanation}</p>
              {f.suggestion && <p className="muted small">💡 {f.suggestion}</p>}

              {f.resolution ? (
                <p className={`small resolution res-${f.resolution.action}`}>
                  {f.resolution.action === 'accept-now' && `✔ Accepted into canon (v${f.resolution.canonVersion})`}
                  {f.resolution.action === 'accept-gradually' &&
                    `⏳ Gradual acceptance — canon v${f.resolution.canonVersion} is transitioning`}
                  {f.resolution.action === 'reject' && '✖ Rejected — canon stands; revise the scene(s)'}
                  {f.resolution.note ? ` — ${f.resolution.note}` : ''}
                </p>
              ) : (
                <div className="row finding-actions">
                  <button
                    title="Canon adopts the new value immediately (new canon version)"
                    onClick={async () => {
                      await run(() => api.resolveDrift(storylineId, latest.id, f.id, 'accept-now'));
                      refresh();
                    }}
                  >
                    ✔ Accept now
                  </button>
                  <button
                    title="Mark transitions gradually; future storylines blend toward the new value"
                    onClick={async () => {
                      await run(() => api.resolveDrift(storylineId, latest.id, f.id, 'accept-gradually'));
                      refresh();
                    }}
                  >
                    ⏳ Accept gradually
                  </button>
                  <button
                    className="danger ghost"
                    title="Keep canon; the storyline scene(s) should be revised"
                    onClick={async () => {
                      await run(() => api.resolveDrift(storylineId, latest.id, f.id, 'reject'));
                      refresh();
                    }}
                  >
                    ✖ Reject drift
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
