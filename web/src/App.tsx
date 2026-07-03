import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { CanonSection, StoryMetaEditor } from './CanonPanel';
import { CharactersPanel } from './CharactersPanel';
import { DriftPanel } from './DriftPanel';
import { SceneCard } from './SceneCard';
import { formatRuntime, RuntimeSelect, SeasonPanel } from './SeasonPanel';
import type { AppConfig, Episode, Project, ProjectSummary, Story } from './types';

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [stories, setStories] = useState<Story[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [storyId, setStoryId] = useState<string | null>(null);
  const [story, setStory] = useState<{ story: Story; bible: string; episodes: Episode[] } | null>(null);

  const [episodeId, setEpisodeId] = useState<string | null>(null);
  const [episode, setEpisode] = useState<{ episode: Episode; setting: string; projects: ProjectSummary[] } | null>(null);

  const [storylineId, setStorylineId] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);

  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);

  const refreshStories = useCallback(async () => {
    const res = await run(() => api.listStories());
    if (res) setStories(res.stories);
  }, [run]);

  useEffect(() => {
    api.config().then(setConfig).catch((e) => setError(String(e)));
    refreshStories();
  }, [refreshStories]);

  const openStory = useCallback(
    async (id: string) => {
      setStoryId(id);
      setEpisodeId(null);
      setEpisode(null);
      setStorylineId(null);
      setProject(null);
      const res = await run(() => api.getStory(id));
      if (res) setStory(res);
    },
    [run],
  );

  const openEpisode = useCallback(
    async (id: string) => {
      setEpisodeId(id);
      setStorylineId(null);
      setProject(null);
      const res = await run(() => api.getEpisode(id));
      if (res) setEpisode(res);
    },
    [run],
  );

  const openProject = useCallback(
    async (id: string) => {
      setStorylineId(id);
      const res = await run(() => api.getProject(id));
      if (res) setProject(res.project);
    },
    [run],
  );

  return (
    <div className="app">
      <Sidebar
        stories={stories}
        activeStoryId={storyId}
        onSelect={openStory}
        onCreate={async (title, settingMode) => {
          const res = await run(() => api.createStory({ title, settingMode }));
          if (res) {
            await refreshStories();
            openStory(res.story.id);
          }
        }}
        onImport={async (markdown) => {
          const res = await run(() => api.importStory(markdown));
          if (res) {
            await refreshStories();
            openStory(res.story.id);
            alert(
              `Imported "${res.story.title}" — ${res.episodeCount} episode(s), ${res.storylineCount} storyline(s), ${res.canonVersions} canon version(s).`,
            );
          }
        }}
        onNewFromIdea={() => {
          setStoryId(null);
          setStory(null);
          setEpisodeId(null);
          setEpisode(null);
          setStorylineId(null);
          setProject(null);
        }}
      />
      <main className="main">
        <header className="topbar">
          <h1>🎬 PipBopShorts</h1>
          <div className="crumbs">
            {story && (
              <button className="crumb" onClick={() => openStory(story.story.id)}>
                {story.story.title}
              </button>
            )}
            {episode && <span className="sep">/</span>}
            {episode && (
              <button className="crumb" onClick={() => openEpisode(episode.episode.id)}>
                {episode.episode.title}
              </button>
            )}
            {project && <span className="sep">/</span>}
            {project && <span className="crumb current">{project.storyline.title}</span>}
          </div>
          {config && (
            <span className={`badge ${config.youtubeDryRun ? 'warn' : 'live'}`}>
              YouTube: {config.youtubeDryRun ? 'dry-run' : 'live'}
            </span>
          )}
        </header>

        {error && (
          <div className="error" role="alert">
            {error}
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}
        {busy && <div className="busybar" />}

        <div className="content">
          {!storyId && (
            <Welcome
              config={config}
              onLaunch={async (idea, model, withCanon) => {
                const res = await run(() => api.bootstrapStory(idea, { model, withCanon }));
                if (res) {
                  await refreshStories();
                  openStory(res.story.id);
                }
              }}
            />
          )}

          {storyId && story && !episodeId && config && (
            <StoryPanel
              data={story}
              config={config}
              onChanged={() => openStory(story.story.id)}
              onStoriesChanged={refreshStories}
              onOpenEpisode={openEpisode}
              onDeleted={() => {
                setStoryId(null);
                setStory(null);
                refreshStories();
              }}
              run={run}
            />
          )}

          {episodeId && episode && !storylineId && config && (
            <EpisodePanel
              data={episode}
              config={config}
              onOpenProject={openProject}
              onChanged={() => openEpisode(episode.episode.id)}
              run={run}
            />
          )}

          {storylineId && project && config && (
            <ProjectPanel
              project={project}
              config={config}
              setProject={setProject}
              onBack={() => {
                setStorylineId(null);
                setProject(null);
                if (episodeId) openEpisode(episodeId);
              }}
              run={run}
            />
          )}
        </div>
      </main>
    </div>
  );
}

type Run = <T>(fn: () => Promise<T>) => Promise<T | undefined>;

function Welcome({
  config,
  onLaunch,
}: {
  config: AppConfig | null;
  onLaunch: (idea: string, model: string, withCanon: boolean) => Promise<void>;
}) {
  const [idea, setIdea] = useState('');
  const [model, setModel] = useState('');
  const [withCanon, setWithCanon] = useState(true);
  const [pending, setPending] = useState(false);

  const effectiveModel = model || config?.dissect.defaultModel || 'claude-sonnet-5';

  return (
    <div className="welcome">
      <h2>🎬 Start with an idea</h2>
      <p className="muted">
        Describe your series in a sentence or two — the AI drafts the title, audience, genres, tone, and a complete
        production bible with character visual signatures. You review and edit everything afterwards.
      </p>
      <div className="idea-box">
        <textarea
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          rows={3}
          placeholder='e.g. "Five cute animal friends in a magical grove have tiny, funny adventures — for kids 4–7"'
          disabled={pending}
        />
        <div className="row idea-controls">
          {config && (
            <Field label="AI model">
              <select value={effectiveModel} onChange={(e) => setModel(e.target.value)} disabled={pending}>
                {config.dissect.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <label className="checkbox" title="Also dissect the generated bible into a version-controlled canon registry">
            <input type="checkbox" checked={withCanon} onChange={(e) => setWithCanon(e.target.checked)} disabled={pending} />
            Extract canon too
          </label>
          <button
            className="primary big"
            disabled={pending || !idea.trim()}
            onClick={async () => {
              setPending(true);
              try {
                await onLaunch(idea.trim(), effectiveModel, withCanon);
              } finally {
                setPending(false);
              }
            }}
          >
            {pending ? '✨ Developing your series…' : '✨ Create my series'}
          </button>
        </div>
        {pending && (
          <p className="muted small">
            Writing the bible{withCanon ? ' and extracting canon' : ''} — this takes a minute. Everything will be
            editable when it lands.
          </p>
        )}
      </div>

      <details className="how-it-works">
        <summary>How the studio works</summary>
        <ol>
          <li>A <b>story</b> holds a `.md` bible (characters, setting, style) + production metadata.</li>
          <li><b>Canon</b> turns the bible into version-controlled consistency marks.</li>
          <li>Add an <b>episode</b> with a short brief (AI can draft it from an idea).</li>
          <li><b>Claude</b> writes a shot-by-shot storyline — you pick the model and effort.</li>
          <li>Render each scene with <b>PixVerse</b>, preview, tweak, and check for canon drift.</li>
          <li>Publish the finished short to <b>YouTube Shorts</b>.</li>
        </ol>
        <p className="muted small">Prefer manual setup? Create an empty story from the sidebar.</p>
        <p className="muted small">
          Templates:{' '}
          <a className="md-link" href="/api/templates/story-bible.md" download>
            ⬇ story-bible-template.md
          </a>{' '}
          ·{' '}
          <a className="md-link" href="/api/templates/episode-setting.md" download>
            ⬇ episode-setting-template.md
          </a>
        </p>
      </details>
    </div>
  );
}

function Sidebar({
  stories,
  activeStoryId,
  onSelect,
  onCreate,
  onImport,
  onNewFromIdea,
}: {
  stories: Story[];
  activeStoryId: string | null;
  onSelect: (id: string) => void;
  onCreate: (title: string, settingMode: string) => void;
  onImport: (markdown: string) => void;
  onNewFromIdea: () => void;
}) {
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState('shared');
  return (
    <aside className="sidebar">
      <div className="sidebar-head">Stories</div>
      <div className="sidebar-idea">
        <button className="primary" onClick={onNewFromIdea} title="Describe an idea and let the AI draft the whole series">
          ✨ New from idea
        </button>
      </div>
      <ul className="story-list">
        {stories.map((s) => (
          <li key={s.id}>
            <button className={s.id === activeStoryId ? 'active' : ''} onClick={() => onSelect(s.id)}>
              <span className="story-title">{s.title}</span>
              <span className="story-mode">{s.settingMode === 'per-episode' ? 'per-episode' : 'shared'}</span>
            </button>
          </li>
        ))}
        {stories.length === 0 && <li className="muted small">No stories yet.</li>}
      </ul>
      <form
        className="new-story"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) {
            onCreate(title.trim(), mode);
            setTitle('');
          }
        }}
      >
        <input placeholder="New story title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <select value={mode} onChange={(e) => setMode(e.target.value)} title="Setting mode">
          <option value="shared">Shared setting</option>
          <option value="per-episode">Per-episode setting</option>
        </select>
        <button type="submit">+ Create story</button>
        <label className="upload import-story" title="Import a .story.md package exported from any PipBopShorts instance">
          📥 Import story (.story.md)
          <input
            type="file"
            accept=".md,text/markdown"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              onImport(await file.text());
              e.target.value = '';
            }}
          />
        </label>
      </form>
    </aside>
  );
}

function StoryPanel({
  data,
  config,
  onChanged,
  onStoriesChanged,
  onOpenEpisode,
  onDeleted,
  run,
}: {
  data: { story: Story; bible: string; episodes: Episode[] };
  config: AppConfig;
  onChanged: () => void;
  onStoriesChanged: () => void;
  onOpenEpisode: (id: string) => void;
  onDeleted: () => void;
  run: Run;
}) {
  const [bible, setBible] = useState(data.bible);
  const [mode, setMode] = useState(data.story.settingMode);
  const [epTitle, setEpTitle] = useState('');
  const [epBrief, setEpBrief] = useState('');
  const [epSetting, setEpSetting] = useState('');
  const [epIdea, setEpIdea] = useState('');
  const [epRuntime, setEpRuntime] = useState<number | null>(null);
  const [drafting, setDrafting] = useState(false);

  useEffect(() => {
    setBible(data.bible);
    setMode(data.story.settingMode);
  }, [data]);

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{data.story.title}</h2>
        <div className="row">
          <select
            value={mode}
            onChange={async (e) => {
              setMode(e.target.value as Story['settingMode']);
              await run(() => api.updateStory(data.story.id, { settingMode: e.target.value }));
              onStoriesChanged();
            }}
          >
            <option value="shared">Shared setting across episodes</option>
            <option value="per-episode">Each episode has its own setting</option>
          </select>
          <select
            value={data.story.continuity}
            title="Random: standalone episodes forever. Linear: a planned season arc with continuity between episodes."
            onChange={async (e) => {
              await run(() => api.updateStory(data.story.id, { continuity: e.target.value }));
              onChanged();
            }}
          >
            <option value="random">🎲 Random (episodic, endless)</option>
            <option value="linear">📖 Linear (serialized season arc)</option>
          </select>
          <button
            title="Download this story as a portable .story.md package (bible, episodes, canon, storylines)"
            onClick={async () => {
              const res = await run(() => api.exportStory(data.story.id));
              if (res) {
                const blob = new Blob([res.markdown], { type: 'text/markdown' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = res.filename;
                a.click();
                URL.revokeObjectURL(url);
              }
            }}
          >
            📤 Export .md
          </button>
          <button
            className="danger"
            onClick={async () => {
              if (confirm(`Delete story "${data.story.title}"? This removes all episodes and storylines.`)) {
                await run(() => api.deleteStory(data.story.id));
                onDeleted();
              }
            }}
          >
            Delete story
          </button>
        </div>
      </div>

      <StoryMetaEditor story={data.story} config={config} run={run} onSaved={onStoriesChanged} />

      <section className="card">
        <div className="card-head">
          <h3>Story bible (.md)</h3>
          <div className="row">
            <a className="md-link" href={`/api/stories/${data.story.id}/bible.md`} download title="Download the bible as a .md file">
              ⬇ bible.md
            </a>
            <button
              className="ghost"
              title="Insert the canonical story-bible template"
              onClick={async () => {
                if (bible.trim() && !confirm('Replace the current bible with the template?')) return;
                const res = await run(() => api.storyBibleTemplate(data.story.title));
                if (res) setBible(res.markdown);
              }}
            >
              📋 Insert template
            </button>
            <button
              onClick={async () => {
                await run(() => api.setBible(data.story.id, bible));
                onStoriesChanged();
              }}
            >
              Save bible
            </button>
          </div>
        </div>
        <textarea className="bible" value={bible} onChange={(e) => setBible(e.target.value)} rows={16} />
        <p className="muted small">
          Follow the template sections — premise, audience &amp; tone, world rules, character visual signatures with
          "never change" lists — so canon extraction captures every vital detail for the video AI.
        </p>
      </section>

      <CanonSection story={data.story} config={config} run={run} />

      <CharactersPanel story={data.story} run={run} />

      <SeasonPanel story={data.story} config={config} run={run} onChanged={onChanged} />

      <section className="card">
        <h3>Episodes</h3>
        <ul className="episode-list">
          {data.episodes.map((ep) => (
            <li key={ep.id}>
              <button onClick={() => onOpenEpisode(ep.id)}>
                {ep.plannedNumber != null && <span className="badge">#{ep.plannedNumber}</span>}
                <b>{ep.title}</b>
                {ep.runtimeSec != null && <span className="badge">{formatRuntime(ep.runtimeSec)}</span>}
                {ep.brief && <span className="muted"> — {ep.brief.slice(0, 80)}</span>}
              </button>
            </li>
          ))}
          {data.episodes.length === 0 && <li className="muted small">No episodes yet.</li>}
        </ul>
        <div className="row episode-idea">
          <input
            placeholder='✨ Episode idea, e.g. "the friends chase a runaway picnic basket"'
            value={epIdea}
            onChange={(e) => setEpIdea(e.target.value)}
            disabled={drafting}
          />
          <button
            disabled={drafting || !epIdea.trim()}
            title="AI drafts the title, brief, and setting below — review before adding"
            onClick={async () => {
              setDrafting(true);
              try {
                const res = await run(() => api.draftEpisode(data.story.id, epIdea.trim()));
                if (res) {
                  setEpTitle(res.draft.title);
                  setEpBrief(res.draft.brief);
                  if (res.draft.setting) setEpSetting(res.draft.setting);
                }
              } finally {
                setDrafting(false);
              }
            }}
          >
            {drafting ? 'Drafting…' : '✨ Draft with AI'}
          </button>
        </div>
        <form
          className="new-episode"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!epTitle.trim()) return;
            const payload: { title: string; brief?: string; setting?: string; runtimeSec?: number } = {
              title: epTitle.trim(),
              brief: epBrief,
            };
            if (epRuntime != null) payload.runtimeSec = epRuntime;
            if (mode === 'per-episode' && epSetting.trim()) payload.setting = epSetting;
            await run(() => api.createEpisode(data.story.id, payload));
            setEpTitle('');
            setEpBrief('');
            setEpSetting('');
            setEpIdea('');
            onChanged();
          }}
        >
          <input placeholder="Episode title" value={epTitle} onChange={(e) => setEpTitle(e.target.value)} />
          <textarea
            placeholder="Brief: what happens in this episode?"
            value={epBrief}
            onChange={(e) => setEpBrief(e.target.value)}
            rows={2}
          />
          {mode === 'per-episode' && (
            <textarea
              placeholder="Episode-specific setting (.md) — overrides the bible for this episode"
              value={epSetting}
              onChange={(e) => setEpSetting(e.target.value)}
              rows={3}
            />
          )}
          <div className="row">
            <Field label="Runtime">
              <RuntimeSelect config={config} value={epRuntime} onChange={setEpRuntime} allowDefault />
            </Field>
            <button type="submit">+ Add episode</button>
          </div>
        </form>
      </section>
    </div>
  );
}

function EpisodePanel({
  data,
  config,
  onOpenProject,
  onChanged,
  run,
}: {
  data: { episode: Episode; setting: string; projects: ProjectSummary[] };
  config: AppConfig;
  onOpenProject: (id: string) => void;
  onChanged: () => void;
  run: Run;
}) {
  const [brief, setBrief] = useState(data.episode.brief);
  const [setting, setSetting] = useState(data.setting);
  const [model, setModel] = useState('claude-opus-4-8');
  const [effort, setEffort] = useState('high');
  const [sceneCount, setSceneCount] = useState(5);
  const [guidance, setGuidance] = useState('');
  const [aspectRatio, setAspectRatio] = useState('9:16');
  const [quality, setQuality] = useState('540p');
  const [pixModel, setPixModel] = useState('v5');

  useEffect(() => {
    setBrief(data.episode.brief);
    setSetting(data.setting);
  }, [data]);

  const modelInfo = config.claudeModels.find((m) => m.id === model);

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{data.episode.title}</h2>
      </div>

      <section className="card">
        <div className="card-head">
          <h3>
            Episode brief
            {data.episode.plannedNumber != null && <span className="badge"> #{data.episode.plannedNumber} in season</span>}
          </h3>
          <div className="row">
            <Field label="Runtime">
              <RuntimeSelect
                config={config}
                value={data.episode.runtimeSec}
                allowDefault
                onChange={async (v) => {
                  await run(() => api.updateEpisode(data.episode.id, { runtimeSec: v }));
                  onChanged();
                }}
              />
            </Field>
            <button
              onClick={async () => {
                await run(() => api.updateEpisode(data.episode.id, { brief }));
                onChanged();
              }}
            >
              Save brief
            </button>
          </div>
        </div>
        <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={3} />
      </section>

      {data.episode.hasSettingOverride || data.setting ? (
        <section className="card">
          <div className="card-head">
            <h3>Episode setting (.md)</h3>
            <div className="row">
              <a
                className="md-link"
                href={`/api/episodes/${data.episode.id}/setting.md`}
                download
                title="Download this episode's setting as a .md file"
              >
                ⬇ setting.md
              </a>
              <button
                className="ghost"
                onClick={async () => {
                  if (setting.trim() && !confirm('Replace the current setting with the template?')) return;
                  const res = await run(() => api.episodeSettingTemplate(data.episode.title));
                  if (res) setSetting(res.markdown);
                }}
              >
                📋 Insert template
              </button>
              <button
                onClick={async () => {
                  await run(() => api.setSetting(data.episode.id, setting));
                  onChanged();
                }}
              >
                Save setting
              </button>
            </div>
          </div>
          <textarea value={setting} onChange={(e) => setSetting(e.target.value)} rows={6} />
          <p className="muted small">This overrides the story bible's setting for this episode.</p>
        </section>
      ) : null}

      <section className="card highlight">
        <h3>Generate a storyline with Claude</h3>
        <div className="grid">
          <Field label="Model">
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {config.claudeModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Effort">
            <select value={effort} onChange={(e) => setEffort(e.target.value)} disabled={!modelInfo?.supportsEffort}>
              {config.efforts.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Scenes (target)">
            <input type="number" min={2} max={12} value={sceneCount} onChange={(e) => setSceneCount(Number(e.target.value))} />
          </Field>
          <Field label="Aspect ratio">
            <select value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)}>
              {config.pixverse.aspectRatios.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
          </Field>
          <Field label="Default quality">
            <select value={quality} onChange={(e) => setQuality(e.target.value)}>
              {config.pixverse.qualities.map((q) => (
                <option key={q}>{q}</option>
              ))}
            </select>
          </Field>
          <Field label="Default PixVerse model">
            <select value={pixModel} onChange={(e) => setPixModel(e.target.value)}>
              {config.pixverse.models.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Extra guidance (optional)">
          <textarea value={guidance} onChange={(e) => setGuidance(e.target.value)} rows={2} placeholder="Tone, references, must-have beats…" />
        </Field>
        <button
          className="primary"
          onClick={async () => {
            const res = await run(() =>
              api.createStoryline(data.episode.id, {
                model,
                effort: modelInfo?.supportsEffort ? effort : undefined,
                sceneCount,
                guidance,
                aspectRatio,
                quality,
                pixverseModel: pixModel,
              }),
            );
            if (res) onOpenProject(res.project.storyline.id);
          }}
        >
          ✨ Generate storyline
        </button>
      </section>

      <section className="card">
        <h3>Storylines</h3>
        <ul className="project-list">
          {data.projects.map((p) => (
            <li key={p.storylineId}>
              <button onClick={() => onOpenProject(p.storylineId)}>
                <b>{p.title}</b> <span className="muted">— {p.sceneCount} scenes · {p.model}</span>
                {p.publish?.status === 'published' && <span className="badge live">published</span>}
              </button>
            </li>
          ))}
          {data.projects.length === 0 && <li className="muted small">No storylines generated yet.</li>}
        </ul>
      </section>
    </div>
  );
}

function ProjectPanel({
  project,
  config,
  setProject,
  onBack,
  run,
}: {
  project: Project;
  config: AppConfig;
  setProject: (p: Project) => void;
  onBack: () => void;
  run: Run;
}) {
  const storylineId = project.storyline.id;
  const scenes = useMemo(() => [...project.storyline.scenes].sort((a, b) => a.order - b.order), [project]);
  const [privacy, setPrivacy] = useState('private');
  const [stitch, setStitch] = useState(true);

  const readyCount = scenes.filter((s) => project.clips[s.id]?.status === 'ready').length;

  return (
    <div className="panel">
      <div className="panel-head">
        <button className="link" onClick={onBack}>
          ← Back to episode
        </button>
        <h2>{project.storyline.title}</h2>
        <p className="muted">{project.storyline.logline}</p>
        <div className="row">
          <button
            className="primary"
            onClick={async () => {
              const res = await run(() => api.generateAll(storylineId, true));
              if (res) setProject(res.project);
            }}
          >
            ▶ Render all scenes
          </button>
          <span className="muted small">
            {readyCount}/{scenes.length} scenes ready
          </span>
        </div>
      </div>

      <div className="scenes">
        {scenes.map((scene, i) => (
          <SceneCard
            key={scene.id}
            index={i}
            total={scenes.length}
            scene={scene}
            clip={project.clips[scene.id]}
            config={config}
            storylineId={storylineId}
            setProject={setProject}
            run={run}
          />
        ))}
        <button
          className="add-scene"
          onClick={async () => {
            const res = await run(() => api.addScene(storylineId));
            if (res) setProject(res.project);
          }}
        >
          + Add scene
        </button>
      </div>

      <DriftPanel project={project} config={config} setProject={setProject} run={run} />

      <section className="card">
        <h3>Publish to YouTube Shorts</h3>
        <YoutubeEditor project={project} setProject={setProject} storylineId={storylineId} run={run} />
        <div className="row">
          <Field label="Privacy">
            <select value={privacy} onChange={(e) => setPrivacy(e.target.value)}>
              <option value="private">private</option>
              <option value="unlisted">unlisted</option>
              <option value="public">public</option>
            </select>
          </Field>
          <label className="checkbox">
            <input type="checkbox" checked={stitch} onChange={(e) => setStitch(e.target.checked)} />
            Stitch all clips (needs ffmpeg)
          </label>
          <button
            className="primary"
            disabled={readyCount === 0}
            onClick={async () => {
              const res = await run(() => api.publish(storylineId, { privacyStatus: privacy, stitch }));
              if (res) {
                const p = await api.getProject(storylineId);
                setProject(p.project);
                alert(
                  res.publish.dryRun
                    ? `Dry-run publish OK (id ${res.publish.videoId}). Configure YouTube credentials for real uploads.`
                    : `Published! ${res.publish.url}`,
                );
              }
            }}
          >
            🚀 Publish
          </button>
        </div>
        {project.publish && (
          <p className={`muted small publish-${project.publish.status}`}>
            Last publish: {project.publish.status}
            {project.publish.dryRun ? ' (dry-run)' : ''}
            {project.publish.url ? ` — ${project.publish.url}` : ''}
            {project.publish.error ? ` — ${project.publish.error}` : ''}
          </p>
        )}
      </section>
    </div>
  );
}

function YoutubeEditor({
  project,
  setProject,
  storylineId,
  run,
}: {
  project: Project;
  setProject: (p: Project) => void;
  storylineId: string;
  run: Run;
}) {
  const yt = project.storyline.youtube;
  const [title, setTitle] = useState(yt.title);
  const [description, setDescription] = useState(yt.description);
  const [tags, setTags] = useState(yt.tags.join(', '));
  const [hashtags, setHashtags] = useState(yt.hashtags.join(' '));

  useEffect(() => {
    setTitle(yt.title);
    setDescription(yt.description);
    setTags(yt.tags.join(', '));
    setHashtags(yt.hashtags.join(' '));
  }, [project.storyline.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="youtube-editor">
      <Field label="Title">
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} />
      </Field>
      <Field label="Description">
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
      </Field>
      <div className="grid">
        <Field label="Tags (comma-separated)">
          <input value={tags} onChange={(e) => setTags(e.target.value)} />
        </Field>
        <Field label="Hashtags (space-separated)">
          <input value={hashtags} onChange={(e) => setHashtags(e.target.value)} />
        </Field>
      </div>
      <button
        onClick={async () => {
          const res = await run(() =>
            api.updateYoutube(storylineId, {
              title,
              description,
              tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
              hashtags: hashtags.split(/\s+/).map((t) => t.trim()).filter(Boolean),
            }),
          );
          if (res) setProject(res.project);
        }}
      >
        Save metadata
      </button>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
