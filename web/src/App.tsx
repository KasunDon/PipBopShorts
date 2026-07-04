import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { CanonSection, StoryMetaEditor } from './CanonPanel';
import { CharactersPanel } from './CharactersPanel';
import { CostsPanel } from './CostsPanel';
import { DriftPanel } from './DriftPanel';
import { EventsPanel } from './EventsPanel';
import {
  IconActivity,
  IconAlert,
  IconCheck,
  IconChevronLeft,
  IconClock,
  IconDoc,
  IconDollar,
  IconDownload,
  IconEye,
  IconHome,
  IconImage,
  IconLayers,
  IconPlay,
  IconPlus,
  IconRefresh,
  IconSend,
  IconUpload,
  IconWand,
  IconX,
} from './Icons';
import { Markdown, MarkdownViewer } from './Markdown';
import { SceneCard } from './SceneCard';
import { formatRuntime, RuntimeSelect, SeasonPanel } from './SeasonPanel';
import type {
  AppConfig,
  AutofixResult,
  Beat,
  Episode,
  EpisodeIdea,
  JobEvent,
  Project,
  ProjectSummary,
  ReferenceReadiness,
  ReferenceReadinessItem,
  RenderPreset,
  RenderValidation,
  SceneDialogue,
  SoundPlan,
  Story,
  ThumbnailConcept,
  TitleVariant,
  StoryAnalytics,
  StudioAnalytics,
  StorylinePreview,
} from './types';
import { formatElapsed, useAsyncAction } from './useAsyncAction';

type Overlay = 'costs' | 'events' | null;

interface Toast {
  id: number;
  kind: 'ok' | 'bad';
  text: string;
}

let toastSeq = 0;

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [stories, setStories] = useState<Story[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pendingJobs, setPendingJobs] = useState(0);
  const [lastJob, setLastJob] = useState<JobEvent | null>(null);

  const pushToast = useCallback((kind: Toast['kind'], text: string) => {
    const id = ++toastSeq;
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 7000);
  }, []);

  const [storyId, setStoryId] = useState<string | null>(null);
  const [story, setStory] = useState<{ story: Story; bible: string; episodes: Episode[] } | null>(null);

  const [episodeId, setEpisodeId] = useState<string | null>(null);
  const [episode, setEpisode] = useState<{ episode: Episode; setting: string; projects: ProjectSummary[] } | null>(null);
  const [autoCompileId, setAutoCompileId] = useState<string | null>(null);

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

  // Background render notifications: renders complete server-side (even with the
  // tab closed); when a console *is* open, this stream keeps it live.
  useEffect(() => {
    const source = new EventSource('/api/jobs/stream');
    source.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data.type === 'init') {
          setPendingJobs((data.jobs ?? []).length);
        } else if (data.type === 'queued') {
          setPendingJobs((n) => n + 1);
        } else if (data.type === 'done') {
          setPendingJobs((n) => Math.max(0, n - 1));
          const event = data as JobEvent;
          if (event.status === 'ready') pushToast('ok', `${event.job.label} is ready.`);
          else pushToast('bad', `${event.job.label} ${event.status.replace('_', ' ')}${event.error ? ` — ${event.error}` : ''}`);
          setLastJob(event);
        }
      } catch {
        // ignore malformed frames
      }
    };
    return () => source.close();
  }, [pushToast]);

  const goHome = useCallback(() => {
    setOverlay(null);
    setStoryId(null);
    setStory(null);
    setEpisodeId(null);
    setEpisode(null);
    setStorylineId(null);
    setProject(null);
  }, []);

  const openStory = useCallback(
    async (id: string) => {
      setOverlay(null);
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
    async (id: string, opts: { compile?: boolean } = {}) => {
      setOverlay(null);
      setEpisodeId(id);
      setStorylineId(null);
      setProject(null);
      setAutoCompileId(opts.compile ? id : null);
      const res = await run(() => api.getEpisode(id));
      if (res) setEpisode(res);
    },
    [run],
  );

  const openProject = useCallback(
    async (id: string) => {
      setOverlay(null);
      setStorylineId(id);
      const res = await run(() => api.getProject(id));
      if (res) setProject(res.project);
    },
    [run],
  );

  const showBrowse = overlay === null;

  return (
    <div className="app">
      <Sidebar
        stories={stories}
        activeStoryId={showBrowse ? storyId : null}
        overlay={overlay}
        onHome={goHome}
        onSelect={openStory}
        onOverlay={(o) => setOverlay((cur) => (cur === o ? null : o))}
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
              `Imported "${res.story.title}": ${res.episodeCount} episode(s), ${res.storylineCount} storyline(s), ${res.canonVersions} canon version(s).`,
            );
          }
        }}
      />
      <main className="main">
        <header className="topbar">
          <div className="crumbs">
            {overlay === 'costs' && <span className="crumb current">Costs</span>}
            {overlay === 'events' && <span className="crumb current">Activity</span>}
            {showBrowse && !story && <span className="crumb current">Home</span>}
            {showBrowse && story && (
              <button className="crumb" onClick={() => openStory(story.story.id)}>
                {story.story.title}
              </button>
            )}
            {showBrowse && episode && <span className="sep">/</span>}
            {showBrowse && episode && (
              <button className="crumb" onClick={() => openEpisode(episode.episode.id)}>
                {episode.episode.title}
              </button>
            )}
            {showBrowse && project && storylineId && <span className="sep">/</span>}
            {showBrowse && project && storylineId && <span className="crumb current">{project.storyline.title}</span>}
          </div>
          {pendingJobs > 0 && (
            <span className="badge busy" title="Renders are processed on the server — safe to close the tab">
              Rendering {pendingJobs}
            </span>
          )}
          {config && (
            <span className={`badge ${config.youtubeDryRun ? 'warn' : 'live'}`}>
              YouTube {config.youtubeDryRun ? 'dry-run' : 'live'}
            </span>
          )}
        </header>

        {error && (
          <div className="error" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)} aria-label="Dismiss">
              <IconX />
            </button>
          </div>
        )}
        {busy && <div className="busybar" />}

        <div className="content">
          {overlay === 'events' && <EventsPanel onClose={() => setOverlay(null)} />}
          {overlay === 'costs' && <CostsPanel onClose={() => setOverlay(null)} />}

          {showBrowse && !storyId && (
            <>
              <Welcome
                config={config}
                onLaunch={async (idea, model, withCanon, signal) => {
                  const res = await api.bootstrapStory(idea, { model, withCanon, signal });
                  await refreshStories();
                  openStory(res.story.id);
                }}
              />
              {stories.length > 0 && <StudioDashboard onOpenStory={openStory} />}
            </>
          )}

          {showBrowse && storyId && story && !episodeId && config && (
            <StoryPanel
              data={story}
              config={config}
              lastJob={lastJob}
              onChanged={() => openStory(story.story.id)}
              onStoriesChanged={refreshStories}
              onOpenEpisode={openEpisode}
              onDeleted={() => {
                goHome();
                refreshStories();
              }}
              run={run}
            />
          )}

          {showBrowse && episodeId && episode && !storylineId && config && (
            <EpisodePanel
              data={episode}
              config={config}
              autoCompile={autoCompileId === episodeId}
              onAutoCompileDone={() => setAutoCompileId(null)}
              onOpenProject={openProject}
              onChanged={() => openEpisode(episode.episode.id)}
              run={run}
            />
          )}

          {showBrowse && storylineId && project && config && (
            <ProjectPanel
              project={project}
              config={config}
              setProject={setProject}
              lastJob={lastJob}
              pushToast={pushToast}
              onBack={() => {
                setStorylineId(null);
                setProject(null);
                if (episodeId) openEpisode(episodeId);
              }}
              run={run}
            />
          )}
        </div>

        <div className="toasts" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast toast-${t.kind}`}>
              {t.kind === 'ok' ? <IconCheck /> : <IconAlert />}
              <span>{t.text}</span>
              <button className="ghost small" onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))} aria-label="Dismiss">
                <IconX />
              </button>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}

type Run = <T>(fn: () => Promise<T>) => Promise<T | undefined>;

/* ---------------------------------------------------------------------------
   Sidebar
--------------------------------------------------------------------------- */

function Sidebar({
  stories,
  activeStoryId,
  overlay,
  onHome,
  onSelect,
  onOverlay,
  onCreate,
  onImport,
}: {
  stories: Story[];
  activeStoryId: string | null;
  overlay: Overlay;
  onHome: () => void;
  onSelect: (id: string) => void;
  onOverlay: (o: Exclude<Overlay, null>) => void;
  onCreate: (title: string, settingMode: string) => void;
  onImport: (markdown: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState('shared');
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-name">Backlot</div>
        <div className="brand-sub">AI film production studio</div>
      </div>

      <nav className="nav">
        <button className={`nav-item ${overlay === null && !activeStoryId ? 'active' : ''}`} onClick={onHome}>
          <IconHome /> Home
        </button>
        <button className={`nav-item ${overlay === 'costs' ? 'active' : ''}`} onClick={() => onOverlay('costs')}>
          <IconDollar /> Costs
        </button>
        <button className={`nav-item ${overlay === 'events' ? 'active' : ''}`} onClick={() => onOverlay('events')}>
          <IconActivity /> Activity
        </button>
        <div className="nav-label">Stories</div>
      </nav>

      <ul className="story-list">
        {stories.map((s) => (
          <li key={s.id}>
            <button className={s.id === activeStoryId ? 'active' : ''} onClick={() => onSelect(s.id)}>
              <span className="story-title">{s.title}</span>
              <span className="story-mode">{s.settingMode === 'per-episode' ? 'per-episode' : 'shared'}</span>
            </button>
          </li>
        ))}
        {stories.length === 0 && <li className="empty">No stories yet — start from an idea on Home.</li>}
      </ul>

      <div className="sidebar-foot">
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
          <button type="submit">
            <IconPlus /> Create story
          </button>
          <label className="upload import-story" title="Import a .story.md package exported from any Backlot instance">
            <IconUpload /> Import .story.md
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
      </div>
    </aside>
  );
}

/* ---------------------------------------------------------------------------
   Home — idea launcher
--------------------------------------------------------------------------- */

function Welcome({
  config,
  onLaunch,
}: {
  config: AppConfig | null;
  onLaunch: (idea: string, model: string, withCanon: boolean, signal: AbortSignal) => Promise<void>;
}) {
  const [idea, setIdea] = useState('');
  const [model, setModel] = useState('');
  const [withCanon, setWithCanon] = useState(true);
  const { pending, elapsedSec, error, execute, cancel, dismissError } = useAsyncAction();

  const effectiveModel = model || config?.dissect.defaultModel || 'claude-sonnet-5';

  return (
    <div className="welcome">
      <span className="welcome-kicker">Backlot</span>
      <h2>Start with an idea</h2>
      <p className="muted">
        Describe your series in a sentence or two. The AI drafts the title, audience, genres, tone, and a complete
        production bible with character visual signatures — you review and edit everything before anything is rendered.
      </p>
      <div className="idea-box">
        <textarea
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          rows={3}
          placeholder='e.g. "Five animal friends in a magical grove have tiny, funny adventures — for kids 4-7"'
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
            onClick={() => execute((signal) => onLaunch(idea.trim(), effectiveModel, withCanon, signal))}
          >
            <IconWand /> {pending ? 'Developing your series…' : 'Create series'}
          </button>
        </div>
        {pending && (
          <div className="row idea-progress">
            <p className="muted small">
              Writing the bible{withCanon ? ' and extracting canon' : ''} — {formatElapsed(elapsedSec)} elapsed. This can
              take a few minutes. Everything will be editable when it lands.
            </p>
            <button className="ghost small" onClick={cancel}>
              <IconX /> Cancel
            </button>
          </div>
        )}
        {error && (
          <div className="error inline" role="alert">
            <span>{error}</span>
            <div className="row">
              <button
                className="ghost small"
                onClick={() => execute((signal) => onLaunch(idea.trim(), effectiveModel, withCanon, signal))}
              >
                <IconRefresh /> Retry
              </button>
              <button onClick={dismissError} aria-label="Dismiss">
                <IconX />
              </button>
            </div>
          </div>
        )}
      </div>

      <details className="how-it-works">
        <summary>How the studio works</summary>
        <ol>
          <li>A <b>story</b> holds a markdown bible (characters, setting, style) plus production metadata.</li>
          <li><b>Canon</b> turns the bible into version-controlled consistency marks.</li>
          <li>Add an <b>episode</b> with a short brief — or let the AI draft it.</li>
          <li><b>Compile the script</b> and review exactly what the AI will receive, then generate the storyline.</li>
          <li>Validate, then render each scene with PixVerse; preview, tweak, and check for canon drift.</li>
          <li>Publish the finished short to YouTube Shorts.</li>
        </ol>
        <p className="muted small">Prefer manual setup? Create an empty story from the sidebar.</p>
        <p className="muted small">
          Templates:{' '}
          <a className="md-link" href="/api/templates/story-bible.md" download>
            <IconDownload /> story-bible-template.md
          </a>{' '}
          <a className="md-link" href="/api/templates/episode-setting.md" download>
            <IconDownload /> episode-setting-template.md
          </a>
        </p>
      </details>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Story page (tabbed)
--------------------------------------------------------------------------- */

type StoryTab = 'episodes' | 'insights' | 'bible' | 'canon' | 'references' | 'season' | 'settings';

const STORY_TABS: Array<{ id: StoryTab; label: string }> = [
  { id: 'episodes', label: 'Episodes' },
  { id: 'insights', label: 'Insights' },
  { id: 'bible', label: 'Bible' },
  { id: 'canon', label: 'Canon' },
  { id: 'references', label: 'References' },
  { id: 'season', label: 'Season' },
  { id: 'settings', label: 'Settings' },
];

function StoryPanel({
  data,
  config,
  lastJob,
  onChanged,
  onStoriesChanged,
  onOpenEpisode,
  onDeleted,
  run,
}: {
  data: { story: Story; bible: string; episodes: Episode[] };
  config: AppConfig;
  lastJob: JobEvent | null;
  onChanged: () => void;
  onStoriesChanged: () => void;
  onOpenEpisode: (id: string, opts?: { compile?: boolean }) => void;
  onDeleted: () => void;
  run: Run;
}) {
  const [tab, setTab] = useState<StoryTab>('episodes');

  return (
    <div className="panel">
      <div className="page-head">
        <h2 className="page-title">{data.story.title}</h2>
        <p className="page-sub">
          {data.story.continuity === 'linear' ? 'Serialized season arc' : 'Episodic series'} ·{' '}
          {data.story.settingMode === 'per-episode' ? 'per-episode settings' : 'shared setting'} · {data.episodes.length}{' '}
          episode{data.episodes.length === 1 ? '' : 's'}
        </p>
      </div>

      <div className="tabs" role="tablist">
        {STORY_TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === 'episodes' && <span className="count">{data.episodes.length}</span>}
          </button>
        ))}
      </div>

      {tab === 'episodes' && (
        <EpisodesTab data={data} config={config} onChanged={onChanged} onOpenEpisode={onOpenEpisode} run={run} />
      )}
      {tab === 'insights' && <InsightsTab storyId={data.story.id} run={run} />}
      {tab === 'bible' && <BibleTab data={data} onStoriesChanged={onStoriesChanged} run={run} />}
      {tab === 'canon' && <CanonSection story={data.story} config={config} run={run} />}
      {tab === 'references' && <CharactersPanel story={data.story} run={run} lastJob={lastJob} />}
      {tab === 'season' && <SeasonPanel story={data.story} config={config} run={run} onChanged={onChanged} />}
      {tab === 'settings' && (
        <SettingsTab data={data} config={config} onChanged={onChanged} onStoriesChanged={onStoriesChanged} onDeleted={onDeleted} run={run} />
      )}
    </div>
  );
}

function StudioDashboard({ onOpenStory }: { onOpenStory: (id: string) => void }) {
  const [a, setA] = useState<StudioAnalytics | null>(null);
  useEffect(() => {
    let live = true;
    api.studioAnalytics().then((res) => live && setA(res.analytics)).catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  if (!a || a.stories === 0) return null;

  return (
    <section className="card">
      <div className="card-head">
        <h3>Studio overview</h3>
        <span className="muted small">{a.stories} stories</span>
      </div>
      <div className="stat-grid">
        <div className="stat-tile">
          <span className="stat-value">{a.episodes}</span>
          <span className="stat-label">Episodes</span>
        </div>
        <div className="stat-tile">
          <span className="stat-value">{a.scenes}</span>
          <span className="stat-label">Scenes</span>
        </div>
        <div className="stat-tile">
          <span className="stat-value">{a.approvedClips}</span>
          <span className="stat-label">Approved clips</span>
        </div>
        <div className="stat-tile">
          <span className="stat-value">{a.publishes}</span>
          <span className="stat-label">Published</span>
        </div>
        <div className="stat-tile">
          <span className="stat-value">{a.openDrifts}</span>
          <span className="stat-label">Open drifts</span>
          {a.safetyDrifts > 0 && <span className="stat-sub" style={{ color: 'var(--danger)' }}>{a.safetyDrifts} safety</span>}
        </div>
      </div>
      {a.perStory.some((s) => s.openDrifts > 0 || s.safetyDrifts > 0) && (
        <ul className="studio-risk">
          {a.perStory
            .filter((s) => s.openDrifts > 0 || s.safetyDrifts > 0)
            .slice(0, 5)
            .map((s) => (
              <li key={s.storyId}>
                <button className="link" onClick={() => onOpenStory(s.storyId)}>
                  {s.title}
                </button>
                {s.safetyDrifts > 0 && <span className="badge safety">{s.safetyDrifts} safety</span>}
                <span className="muted small">
                  {s.openDrifts} open drift{s.openDrifts === 1 ? '' : 's'} · rate {s.driftRate}
                </span>
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}

function InsightsTab({ storyId, run }: { storyId: string; run: Run }) {
  const [a, setA] = useState<StoryAnalytics | null>(null);

  useEffect(() => {
    let live = true;
    run(() => api.storyAnalytics(storyId)).then((res) => {
      if (live && res) setA(res.analytics);
    });
    return () => {
      live = false;
    };
  }, [storyId, run]);

  if (!a) return <p className="muted small">Loading insights…</p>;

  const tile = (label: string, value: string | number, sub?: string) => (
    <div className="stat-tile">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
      {sub && <span className="stat-sub muted small">{sub}</span>}
    </div>
  );

  return (
    <section className="card">
      <div className="card-head">
        <h3>Production insights</h3>
      </div>
      <div className="stat-grid">
        {tile('Episodes', a.episodes)}
        {tile('Storylines', a.storylines)}
        {tile('Scenes', a.scenes)}
        {tile('Clips ready', `${a.clips.ready}/${a.clips.total}`, `${a.clips.approved} approved`)}
        {tile('Published', a.publishes)}
        {tile('Canon', `v${a.canon.versions}`, `${a.canon.entities} entities · ${a.canon.marks} marks (${a.canon.lockedMarks} locked)`)}
        {tile('Open drifts', a.drift.open, `${a.drift.resolved} resolved · ${a.drift.safety} safety`)}
        {tile('Drift rate', a.drift.driftRate, 'open findings ÷ scenes')}
      </div>
    </section>
  );
}

function EpisodesTab({
  data,
  config,
  onChanged,
  onOpenEpisode,
  run,
}: {
  data: { story: Story; episodes: Episode[] };
  config: AppConfig;
  onChanged: () => void;
  onOpenEpisode: (id: string, opts?: { compile?: boolean }) => void;
  run: Run;
}) {
  const [epTitle, setEpTitle] = useState('');
  const [epBrief, setEpBrief] = useState('');
  const [epSetting, setEpSetting] = useState('');
  const [epIdea, setEpIdea] = useState('');
  const [epRuntime, setEpRuntime] = useState<number | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [ideas, setIdeas] = useState<EpisodeIdea[] | null>(null);
  const [loadingIdeas, setLoadingIdeas] = useState(false);
  const perEpisode = data.story.settingMode === 'per-episode';

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h3>Episodes</h3>
          <button
            className="small"
            disabled={loadingIdeas}
            title="Brainstorm future episode ideas grounded in the bible and canon"
            onClick={async () => {
              setLoadingIdeas(true);
              try {
                const res = await run(() => api.suggestEpisodeIdeas(data.story.id, { count: 6 }));
                if (res) setIdeas(res.ideas);
              } finally {
                setLoadingIdeas(false);
              }
            }}
          >
            <IconWand /> {loadingIdeas ? 'Thinking…' : 'Suggest ideas'}
          </button>
        </div>

        {ideas && (
          <div className="idea-backlog">
            <div className="card-head">
              <span className="muted small">Idea backlog — {ideas.length} future episodes</span>
              <button className="ghost small" onClick={() => setIdeas(null)} aria-label="Dismiss">
                <IconX />
              </button>
            </div>
            <ul className="idea-list">
              {ideas.map((idea, i) => (
                <li key={i} className="idea-item">
                  <div className="idea-text">
                    <b>{idea.title}</b>
                    <span className="idea-hook">{idea.hook}</span>
                    <span className="muted small">{idea.synopsis}</span>
                  </div>
                  <button
                    className="small primary"
                    title="Send this to the episode drafter below"
                    onClick={() => {
                      setEpIdea(`${idea.title}: ${idea.synopsis}`);
                      document.querySelector('.episode-idea input')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }}
                  >
                    Develop
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="card-sub">
          Open an episode to compile and review its script before generating a storyline. Nothing is sent to the video
          renderer without a reviewed script and a validated storyline.
        </p>
        <ul className="episode-list">
          {data.episodes.map((ep) => (
            <li key={ep.id} className="episode-row">
              <button className="ep-main" onClick={() => onOpenEpisode(ep.id)}>
                {ep.plannedNumber != null && <span className="badge plain">#{ep.plannedNumber}</span>}
                <span className="ep-title">{ep.title}</span>
                {ep.runtimeSec != null && <span className="badge plain">{formatRuntime(ep.runtimeSec)}</span>}
                {ep.brief && <span className="ep-brief">{ep.brief}</span>}
              </button>
              <button
                className="small"
                title="Compile the episode script (bible + setting + brief + canon) and review it before generating"
                onClick={() => onOpenEpisode(ep.id, { compile: true })}
              >
                <IconDoc /> Compile script
              </button>
            </li>
          ))}
          {data.episodes.length === 0 && <li className="muted small">No episodes yet — add one below or use the Season tab.</li>}
        </ul>

        <div className="row episode-idea">
          <input
            placeholder='Episode idea, e.g. "the friends chase a runaway picnic basket"'
            value={epIdea}
            onChange={(e) => setEpIdea(e.target.value)}
            disabled={drafting}
          />
          <button
            disabled={drafting || !epIdea.trim()}
            title="The AI drafts the title, brief, and setting below — review before adding"
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
            <IconWand /> {drafting ? 'Drafting…' : 'Draft with AI'}
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
            if (perEpisode && epSetting.trim()) payload.setting = epSetting;
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
          {perEpisode && (
            <textarea
              placeholder="Episode-specific setting (markdown) — overrides the bible for this episode"
              value={epSetting}
              onChange={(e) => setEpSetting(e.target.value)}
              rows={3}
            />
          )}
          <div className="row">
            <Field label="Runtime">
              <RuntimeSelect config={config} value={epRuntime} onChange={setEpRuntime} allowDefault />
            </Field>
            <button type="submit">
              <IconPlus /> Add episode
            </button>
          </div>
        </form>
      </section>
    </>
  );
}

function BibleTab({
  data,
  onStoriesChanged,
  run,
}: {
  data: { story: Story; bible: string };
  onStoriesChanged: () => void;
  run: Run;
}) {
  const [bible, setBible] = useState(data.bible);
  const [previewing, setPreviewing] = useState(false);
  useEffect(() => setBible(data.bible), [data.bible]);

  return (
    <section className="card">
      <div className="card-head">
        <h3>Story bible</h3>
        <div className="row">
          <div className="seg">
            <button type="button" className={!previewing ? 'seg-on' : ''} onClick={() => setPreviewing(false)}>
              Edit
            </button>
            <button type="button" className={previewing ? 'seg-on' : ''} onClick={() => setPreviewing(true)}>
              Preview
            </button>
          </div>
          <a className="md-link" href={`/api/stories/${data.story.id}/bible.md`} download title="Download the bible as a .md file">
            <IconDownload /> bible.md
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
            Insert template
          </button>
          <button
            className="primary"
            onClick={async () => {
              await run(() => api.setBible(data.story.id, bible));
              onStoriesChanged();
            }}
          >
            Save bible
          </button>
        </div>
      </div>
      {previewing ? (
        <div className="md-viewer">
          <div className="md-viewer-body" style={{ maxHeight: 620 }}>
            <Markdown source={bible} />
          </div>
        </div>
      ) : (
        <textarea className="bible" value={bible} onChange={(e) => setBible(e.target.value)} rows={22} />
      )}
      <p className="muted small">
        Follow the template sections — premise, audience and tone, world rules, character visual signatures with
        "never change" lists — so canon extraction captures every detail the video AI needs.
      </p>
    </section>
  );
}

function SettingsTab({
  data,
  config,
  onChanged,
  onStoriesChanged,
  onDeleted,
  run,
}: {
  data: { story: Story };
  config: AppConfig;
  onChanged: () => void;
  onStoriesChanged: () => void;
  onDeleted: () => void;
  run: Run;
}) {
  return (
    <>
      <section className="card">
        <h3>Story structure</h3>
        <div className="grid">
          <Field label="Setting mode">
            <select
              value={data.story.settingMode}
              onChange={async (e) => {
                await run(() => api.updateStory(data.story.id, { settingMode: e.target.value }));
                onChanged();
                onStoriesChanged();
              }}
            >
              <option value="shared">Shared setting across episodes</option>
              <option value="per-episode">Each episode has its own setting</option>
            </select>
          </Field>
          <Field label="Continuity">
            <select
              value={data.story.continuity}
              onChange={async (e) => {
                await run(() => api.updateStory(data.story.id, { continuity: e.target.value }));
                onChanged();
              }}
            >
              <option value="random">Episodic — standalone episodes, endless</option>
              <option value="linear">Linear — planned season arc</option>
            </select>
          </Field>
        </div>
      </section>

      <StoryMetaEditor story={data.story} config={config} run={run} onSaved={onStoriesChanged} />

      <section className="card">
        <h3>Export and danger zone</h3>
        <div className="row">
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
            <IconDownload /> Export .story.md
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
      </section>
    </>
  );
}

/* ---------------------------------------------------------------------------
   Episode page — compile-first pipeline
--------------------------------------------------------------------------- */

function EpisodePanel({
  data,
  config,
  autoCompile,
  onAutoCompileDone,
  onOpenProject,
  onChanged,
  run,
}: {
  data: { episode: Episode; setting: string; projects: ProjectSummary[] };
  config: AppConfig;
  autoCompile: boolean;
  onAutoCompileDone: () => void;
  onOpenProject: (id: string) => void;
  onChanged: () => void;
  run: Run;
}) {
  const [brief, setBrief] = useState(data.episode.brief);
  const [setting, setSetting] = useState(data.setting);
  const [model, setModel] = useState('claude-opus-4-8');
  const [effort, setEffort] = useState('high');
  const [sceneCount, setSceneCount] = useState(5);
  const [structure, setStructure] = useState<'single' | 'three-act' | 'parallel'>('single');
  const [guidance, setGuidance] = useState('');
  const [beats, setBeats] = useState<Beat[] | null>(null);
  const [beating, setBeating] = useState(false);
  const [aspectRatio, setAspectRatio] = useState('9:16');
  const [quality, setQuality] = useState('540p');
  const [pixModel, setPixModel] = useState('v5');
  const [preview, setPreview] = useState<StorylinePreview | null>(null);
  const [compiling, setCompiling] = useState(false);
  const compiledFor = useRef<string | null>(null);
  // Storyline generation is a multi-minute LLM call — drive it with an elapsed
  // readout + cancel so the user knows work is happening behind the scenes.
  const gen = useAsyncAction();

  useEffect(() => {
    setBrief(data.episode.brief);
    setSetting(data.setting);
    setPreview(null);
  }, [data]);

  const compile = useCallback(async () => {
    setCompiling(true);
    try {
      const res = await run(() => api.storylinePreview(data.episode.id));
      if (res) setPreview(res.preview);
    } finally {
      setCompiling(false);
    }
  }, [run, data.episode.id]);

  // "Compile script" from the episodes list lands here with compile intent.
  useEffect(() => {
    if (autoCompile && compiledFor.current !== data.episode.id) {
      compiledFor.current = data.episode.id;
      compile().then(onAutoCompileDone);
    }
  }, [autoCompile, compile, data.episode.id, onAutoCompileDone]);

  const modelInfo = config.claudeModels.find((m) => m.id === model);
  const reviewed = preview !== null;
  const canGenerate = reviewed && preview.ok;

  return (
    <div className="panel">
      <div className="page-head">
        <h2 className="page-title">{data.episode.title}</h2>
        <p className="page-sub">
          {data.episode.plannedNumber != null ? `Episode #${data.episode.plannedNumber} in season · ` : ''}
          Compile and review the script, generate the storyline, then move to production.
        </p>
      </div>

      {/* Step 1 — script */}
      <section className={`card step ${reviewed ? 'step-done' : 'step-active'}`}>
        <div className="card-head">
          <div className="step-title">
            <span className="step-num">{reviewed ? <IconCheck /> : '1'}</span>
            <h3>Script — compile and review</h3>
          </div>
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
            <button className="primary" onClick={compile} disabled={compiling}>
              <IconDoc /> {compiling ? 'Compiling…' : reviewed ? 'Recompile script' : 'Compile script'}
            </button>
          </div>
        </div>
        <Field label="Brief — what happens in this episode">
          <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={3} />
        </Field>

        {(data.episode.hasSettingOverride || data.setting) && (
          <>
            <div className="card-head" style={{ marginTop: 14 }}>
              <h4>Episode setting (overrides the bible)</h4>
              <div className="row">
                <a className="md-link" href={`/api/episodes/${data.episode.id}/setting.md`} download>
                  <IconDownload /> setting.md
                </a>
                <button
                  className="ghost small"
                  onClick={async () => {
                    if (setting.trim() && !confirm('Replace the current setting with the template?')) return;
                    const res = await run(() => api.episodeSettingTemplate(data.episode.title));
                    if (res) setSetting(res.markdown);
                  }}
                >
                  Insert template
                </button>
                <button
                  className="small"
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
          </>
        )}

        {preview && (
          <div className="preview-box">
            <div className="card-head">
              <h4>Compiled script — exactly what the AI will receive</h4>
              <button className="ghost small" onClick={() => setPreview(null)}>
                <IconX /> Close
              </button>
            </div>
            <ul className="check-list">
              {preview.checks.map((c, i) => (
                <li key={i} className={`check check-${c.level === 'ok' ? 'ok' : c.level === 'warn' ? 'warn' : 'error'}`}>
                  <span className="check-text">{c.message}</span>
                </li>
              ))}
            </ul>
            {!preview.ok && (
              <p className="gate-note">
                <IconAlert /> Fix the blocking issue above, then recompile — generation stays disabled until the script
                passes.
              </p>
            )}
            <MarkdownViewer source={preview.markdown} maxHeight={440} />
          </div>
        )}
      </section>

      {/* Step 2 — storyline */}
      <section className={`card step ${canGenerate ? 'step-active' : ''}`}>
        <div className="card-head">
          <div className="step-title">
            <span className="step-num">2</span>
            <h3>Storyline — generate the shot list</h3>
          </div>
        </div>
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
          <Field label="Structure">
            <select value={structure} onChange={(e) => setStructure(e.target.value as 'single' | 'three-act' | 'parallel')}>
              <option value="single">Single thread</option>
              <option value="three-act">Three-act arc</option>
              <option value="parallel">Parallel threads</option>
            </select>
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
          <Field label="Video model">
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

        <div className="row" style={{ marginTop: 4 }}>
          <button
            className="small ghost"
            disabled={beating}
            title="Draft a structural beat sheet you can fold into the guidance above"
            onClick={async () => {
              setBeating(true);
              try {
                const res = await run(() => api.generateBeatSheet(data.episode.id));
                if (res) setBeats(res.beats);
              } finally {
                setBeating(false);
              }
            }}
          >
            <IconDoc /> {beating ? 'Drafting…' : 'Beat sheet'}
          </button>
          {beats && beats.length > 0 && (
            <button
              className="small"
              title="Fold these beats into the guidance"
              onClick={() =>
                setGuidance((g) =>
                  [g, 'Follow this beat sheet:', ...beats.map((b, i) => `${i + 1}. ${b.name} — ${b.description}`)]
                    .filter(Boolean)
                    .join('\n'),
                )
              }
            >
              Use as guidance
            </button>
          )}
        </div>
        {beats && beats.length > 0 && (
          <ol className="beat-list">
            {beats.map((b, i) => (
              <li key={i}>
                <b>{b.name}</b> — {b.description} <span className="muted small">({b.purpose})</span>
              </li>
            ))}
          </ol>
        )}
        <div className="row" style={{ marginTop: 12 }}>
          <button
            className="primary"
            disabled={!canGenerate || gen.pending}
            title={canGenerate ? 'Generate the storyline with the AI' : 'Compile and review the script first'}
            onClick={async () => {
              const res = await gen.execute((signal) =>
                api.createStoryline(data.episode.id, {
                  model,
                  effort: modelInfo?.supportsEffort ? effort : undefined,
                  sceneCount,
                  structure,
                  guidance,
                  aspectRatio,
                  quality,
                  pixverseModel: pixModel,
                  signal,
                }),
              );
              if (res) onOpenProject(res.project.storyline.id);
            }}
          >
            <IconWand /> {gen.pending ? 'Generating…' : 'Generate storyline'}
          </button>
          {gen.pending && (
            <>
              <span className="gate-note">
                <IconClock /> Writing the shot list with {modelInfo?.label ?? model} — {formatElapsed(gen.elapsedSec)}{' '}
                elapsed. This runs behind the scenes; keep this tab open.
              </span>
              <button className="ghost" onClick={gen.cancel}>
                Cancel
              </button>
            </>
          )}
          {!gen.pending && !canGenerate && (
            <span className="gate-note">
              <IconAlert />
              {reviewed ? 'The compiled script has a blocking issue.' : 'Compile and review the script first (step 1).'}
            </span>
          )}
        </div>
        {gen.error && (
          <p className="check check-error" style={{ marginTop: 8 }}>
            <span className="check-text">{gen.error}</span>
            <button className="ghost small" onClick={gen.dismissError} aria-label="Dismiss">
              <IconX />
            </button>
          </p>
        )}
      </section>

      {/* Existing storylines */}
      <section className="card">
        <h3>Storylines</h3>
        <ul className="project-list">
          {data.projects.map((p) => (
            <li key={p.storylineId}>
              <button onClick={() => onOpenProject(p.storylineId)}>
                <b>{p.title}</b>
                <span className="muted small">
                  {p.sceneCount} scenes · {p.model}
                </span>
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

/* ---------------------------------------------------------------------------
   Production page (storyline)
--------------------------------------------------------------------------- */

function ProjectPanel({
  project,
  config,
  setProject,
  lastJob,
  pushToast,
  onBack,
  run,
}: {
  project: Project;
  config: AppConfig;
  setProject: (p: Project) => void;
  lastJob: JobEvent | null;
  pushToast: (kind: Toast['kind'], text: string) => void;
  onBack: () => void;
  run: Run;
}) {
  const storylineId = project.storyline.id;
  const storyId = project.storyline.storyId;
  const scenes = useMemo(() => [...project.storyline.scenes].sort((a, b) => a.order - b.order), [project]);
  const [privacy, setPrivacy] = useState('private');
  const [stitch, setStitch] = useState(true);
  const [scheduleAt, setScheduleAt] = useState('');
  const [renderAt, setRenderAt] = useState('');
  const [validation, setValidation] = useState<RenderValidation | null>(null);
  const [autofix, setAutofix] = useState<AutofixResult | null>(null);
  const [dialogue, setDialogue] = useState<SceneDialogue[] | null>(null);
  const [planningDialogue, setPlanningDialogue] = useState(false);
  const [sound, setSound] = useState<SoundPlan | null>(null);
  const [planningSound, setPlanningSound] = useState(false);
  const [readiness, setReadiness] = useState<ReferenceReadiness | null>(null);
  const [gateOpen, setGateOpen] = useState(false);
  const [globalAspect, setGlobalAspect] = useState(scenes[0]?.aspectRatio ?? config.pixverse.aspectRatios[0]);
  const [globalQuality, setGlobalQuality] = useState(scenes[0]?.quality ?? config.pixverse.qualities[0]);
  const [globalMotion, setGlobalMotion] = useState(scenes[0]?.motionMode ?? config.pixverse.motionModes[0]);
  const [globalModel, setGlobalModel] = useState(scenes[0]?.model ?? config.pixverse.models[0]);
  const [globalStyle, setGlobalStyle] = useState(scenes[0]?.style ?? config.pixverse.styles[0]);
  const [applyingDefaults, setApplyingDefaults] = useState(false);
  const [presets, setPresets] = useState<RenderPreset[]>([]);

  const refreshPresets = useCallback(async () => {
    const res = await api.listPresets().catch(() => null);
    if (res) setPresets(res.presets);
  }, []);
  useEffect(() => {
    void refreshPresets();
  }, [refreshPresets]);

  const loadPreset = (p: RenderPreset) => {
    if (p.aspectRatio) setGlobalAspect(p.aspectRatio);
    if (p.quality) setGlobalQuality(p.quality);
    if (p.motionMode) setGlobalMotion(p.motionMode);
    if (p.model) setGlobalModel(p.model);
    if (p.style) setGlobalStyle(p.style);
  };

  const saveCurrentAsPreset = async () => {
    const name = prompt('Name this render preset:');
    if (!name || !name.trim()) return;
    const res = await run(() =>
      api.createPreset({
        name: name.trim(),
        aspectRatio: globalAspect,
        quality: globalQuality,
        motionMode: globalMotion,
        model: globalModel,
        style: globalStyle,
      }),
    );
    if (res) {
      await refreshPresets();
      pushToast('ok', `Saved preset “${res.preset.name}”.`);
    }
  };

  const readyCount = scenes.filter((s) => project.clips[s.id]?.status === 'ready').length;
  const approvedCount = scenes.filter((s) => project.clips[s.id]?.approved).length;
  const generatingCount = scenes.filter((s) => project.clips[s.id]?.status === 'generating').length;
  const canRenderAll = validation !== null && validation.ok && generatingCount === 0;
  // Publishing is gated on every rendered clip being approved.
  const canPublish =
    readyCount > 0 &&
    scenes.filter((s) => project.clips[s.id]?.status === 'ready').every((s) => project.clips[s.id]?.approved);

  // Reference lookup so each scene can show which characters/locations it uses
  // and whether they're approved — reviewable before rendering.
  const refByEntity = useMemo(() => {
    const map = new Map<string, ReferenceReadinessItem>();
    for (const it of readiness?.items ?? []) map.set(it.entityId, it);
    return map;
  }, [readiness]);

  const refreshReadiness = useCallback(async () => {
    const res = await api.referenceReadiness(storylineId).catch(() => null);
    if (res) setReadiness(res.readiness);
    return res?.readiness ?? null;
  }, [storylineId]);

  useEffect(() => {
    void refreshReadiness();
  }, [refreshReadiness, project]);

  // A background render for this storyline finished — pull the fresh project.
  useEffect(() => {
    if (lastJob?.type === 'done' && lastJob.job.ref.kind === 'clip' && lastJob.job.ref.storylineId === storylineId) {
      api.getProject(storylineId).then((res) => setProject(res.project)).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastJob, storylineId]);

  const confirmAndRenderAll = async () => {
    if (!validation) return;
    if (
      !confirm(
        `Render all ${scenes.length} scenes?\n\nEstimated cost: ${validation.estUsdLabel} (${validation.totalCredits} credits, ${validation.totalDurationSec}s total). This spends PixVerse credits.\n\nRenders run in the background — you'll be notified as each scene finishes, even if you navigate away.`,
      )
    )
      return;
    const res = await run(() => api.generateAll(storylineId, false));
    if (res) setProject(res.project);
  };

  // Gate render-all on reference approval: if any referenced character/location
  // isn't approved, warn first (with the option to proceed anyway).
  const startRenderAll = async () => {
    if (!validation) return;
    const current = readiness ?? (await refreshReadiness());
    if (current && !current.ready) {
      setGateOpen(true);
      return;
    }
    await confirmAndRenderAll();
  };

  const applyGlobalSettings = async () => {
    setApplyingDefaults(true);
    try {
      const res = await run(() =>
        api.applySceneDefaults(storylineId, {
          aspectRatio: globalAspect,
          quality: globalQuality,
          motionMode: globalMotion,
          model: globalModel,
          style: globalStyle,
        }),
      );
      if (res) {
        setProject(res.project);
        setValidation(null); // params changed — re-validate before rendering
        const skipped = res.skipped.length ? ` (${res.skipped.length} skipped as invalid)` : '';
        pushToast('ok', `Applied ${res.fields.join(', ')} to ${res.applied.length} scene(s)${skipped}.`);
      }
    } finally {
      setApplyingDefaults(false);
    }
  };

  return (
    <div className="panel">
      <div className="page-head">
        <button className="link back" onClick={onBack}>
          <IconChevronLeft /> Back to episode
        </button>
        <h2 className="page-title">{project.storyline.title}</h2>
        <p className="page-sub">{project.storyline.logline}</p>
        <div className="row">
          <button
            title="Validate every scene against the video renderer's rules and estimate the cost before spending credits"
            onClick={async () => {
              const res = await run(() => api.validateStoryline(storylineId));
              if (res) setValidation(res.validation);
            }}
          >
            <IconEye /> Validate and estimate cost
          </button>
          <a className="btn-link" href={`/api/storylines/${storylineId}/manifest.md`} download title="Download the per-scene shot manifest (production document)">
            <IconDownload /> Shot manifest
          </a>
          <button
            disabled={planningDialogue}
            title="Draft per-scene captions (sound-off) and any dialogue lines"
            onClick={async () => {
              setPlanningDialogue(true);
              try {
                const res = await run(() => api.planDialogue(storylineId));
                if (res) setDialogue(res.plan);
              } finally {
                setPlanningDialogue(false);
              }
            }}
          >
            <IconDoc /> {planningDialogue ? 'Writing…' : 'Dialogue & captions'}
          </button>
          <button
            disabled={planningSound}
            title="Draft an overall music direction and per-scene sound-effect cues"
            onClick={async () => {
              setPlanningSound(true);
              try {
                const res = await run(() => api.planSound(storylineId));
                if (res) setSound(res.plan);
              } finally {
                setPlanningSound(false);
              }
            }}
          >
            <IconDoc /> {planningSound ? 'Scoring…' : 'Music & SFX'}
          </button>
          <button
            className="primary"
            disabled={!canRenderAll}
            title={canRenderAll ? 'Render every scene' : 'Run validation first — rendering unlocks once every scene passes'}
            onClick={startRenderAll}
          >
            <IconPlay /> Render all scenes
          </button>
          <span className="badge plain">
            {readyCount}/{scenes.length} ready
          </span>
          {readyCount > 0 && (
            <span className={`badge ${approvedCount === readyCount ? 'live' : 'warn'}`}>{approvedCount} approved</span>
          )}
          {generatingCount > 0 && <span className="badge busy">{generatingCount} rendering</span>}
          {!canRenderAll && (
            <span className="gate-note">
              <IconAlert /> {validation ? 'Fix the failing scenes below, then validate again.' : 'Validate before rendering.'}
            </span>
          )}
        </div>

        {/* Global settings — set once, apply to every scene. */}
        <div className="global-settings">
          <IconLayers />
          <span className="muted small">Apply to all scenes:</span>
          <label className="global-field">
            Aspect ratio
            <select value={globalAspect} onChange={(e) => setGlobalAspect(e.target.value)}>
              {config.pixverse.aspectRatios.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
          </label>
          <label className="global-field">
            Quality
            <select value={globalQuality} onChange={(e) => setGlobalQuality(e.target.value)}>
              {config.pixverse.qualities.map((q) => (
                <option key={q}>{q}</option>
              ))}
            </select>
          </label>
          <label className="global-field">
            Motion
            <select value={globalMotion} onChange={(e) => setGlobalMotion(e.target.value)}>
              {config.pixverse.motionModes.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <label className="global-field">
            Model
            <select value={globalModel} onChange={(e) => setGlobalModel(e.target.value)}>
              {config.pixverse.models.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <label className="global-field">
            Style
            <select value={globalStyle} onChange={(e) => setGlobalStyle(e.target.value)}>
              {config.pixverse.styles.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <button
            className="small"
            disabled={applyingDefaults}
            onClick={applyGlobalSettings}
            title="Set these render settings on every scene at once (scenes they'd invalidate are skipped)"
          >
            {applyingDefaults ? 'Applying…' : 'Apply to all'}
          </button>
          <span className="global-sep" />
          {presets.length > 0 && (
            <label className="global-field">
              Preset
              <select
                value=""
                onChange={(e) => {
                  const p = presets.find((x) => x.id === e.target.value);
                  if (p) loadPreset(p);
                }}
              >
                <option value="">Load…</option>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button className="small ghost" onClick={saveCurrentAsPreset} title="Save the current settings as a reusable preset">
            Save preset
          </button>
          <span className="global-sep" />
          {project.renderSchedule?.status === 'pending' ? (
            <>
              <span className="badge warn">render {new Date(project.renderSchedule.at).toLocaleString()}</span>
              <button
                className="small ghost"
                onClick={async () => {
                  const res = await run(() => api.cancelRenderSchedule(storylineId));
                  if (res) {
                    const p = await api.getProject(storylineId);
                    setProject(p.project);
                  }
                }}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <input
                type="datetime-local"
                value={renderAt}
                onChange={(e) => setRenderAt(e.target.value)}
                title="Schedule the full render for later"
              />
              <button
                className="small"
                disabled={!canRenderAll || !renderAt}
                title={canRenderAll ? 'Queue the full render for the chosen time' : 'Validate first'}
                onClick={async () => {
                  const res = await run(() => api.scheduleRender(storylineId, new Date(renderAt).toISOString()));
                  if (res) {
                    const p = await api.getProject(storylineId);
                    setProject(p.project);
                    pushToast('ok', `Render scheduled for ${new Date(res.renderSchedule.at).toLocaleString()}.`);
                  }
                }}
              >
                Schedule render
              </button>
            </>
          )}
          {readiness && readiness.items.length > 0 && (
            <span className={`ref-summary ${readiness.ready ? 'ok' : 'warn'}`}>
              {readiness.ready ? (
                <>
                  <IconCheck /> {readiness.items.length} reference(s) approved
                </>
              ) : (
                <>
                  <IconAlert /> {readiness.unapproved.length} of {readiness.items.length} reference(s) not approved
                </>
              )}
            </span>
          )}
        </div>
        {validation && (
          <div className={`validation-box ${validation.ok ? 'ok' : 'bad'}`}>
            <div className="card-head">
              <span className="validation-headline">
                Estimated render cost {validation.estUsdLabel} · {validation.totalCredits} credits ·{' '}
                {validation.totalDurationSec}s total across {validation.scenes.length} clips
              </span>
              <button className="ghost small" onClick={() => setValidation(null)} aria-label="Dismiss">
                <IconX />
              </button>
            </div>
            {validation.ok ? (
              <p className="check check-ok">
                <span className="check-text">All {validation.scenes.length} scenes pass validation.</span>
              </p>
            ) : (
              <>
                <div className="row validation-fix-row">
                  <p className="check check-error">
                    <span className="check-text">{validation.invalidCount} scene(s) have parameter issues:</span>
                  </p>
                  <button
                    className="primary small"
                    title="Let the AI resolve these render-parameter issues in a way that fits each scene — it never rewrites your prompts"
                    onClick={async () => {
                      const res = await run(() => api.autofixStoryline(storylineId));
                      if (res) {
                        setAutofix(res.result);
                        setValidation(res.validation);
                        const fresh = await api.getProject(storylineId).catch(() => null);
                        if (fresh) setProject(fresh.project);
                        pushToast(res.result.ok ? 'ok' : 'bad', res.result.summary);
                      }
                    }}
                  >
                    <IconCheck /> Fix all issues automatically
                  </button>
                </div>
                <ul className="check-list">
                  {validation.scenes
                    .filter((s) => s.issues.length > 0)
                    .map((s) => (
                      <li key={s.sceneId} className="check check-error">
                        <span className="check-text">
                          <b>{s.heading}:</b> {s.issues.join(' ')}
                        </span>
                      </li>
                    ))}
                </ul>
              </>
            )}
            {autofix && autofix.fixes.length > 0 && (
              <div className="autofix-summary">
                <p className="check check-ok">
                  <span className="check-text">{autofix.summary}</span>
                </p>
                <ul className="check-list">
                  {autofix.fixes
                    .filter((f) => f.changes.length > 0)
                    .map((f) => (
                      <li key={f.sceneId} className="muted small">
                        <b>Scene {f.sceneNumber}:</b> {f.changes.join(', ')} — {f.rationale}
                        {f.method === 'deterministic' && <span className="muted"> (safe default)</span>}
                      </li>
                    ))}
                </ul>
              </div>
            )}
            <p className="muted small">
              Video costs are estimates (the provider bills in credits) — reconcile against your invoice in Costs.
            </p>
          </div>
        )}

        {dialogue && dialogue.length > 0 && (
          <div className="dialogue-plan">
            <div className="card-head">
              <span className="muted small">Dialogue & captions (sound-off ready)</span>
              <button className="ghost small" onClick={() => setDialogue(null)} aria-label="Dismiss">
                <IconX />
              </button>
            </div>
            <ul className="dialogue-list">
              {dialogue.map((d) => (
                <li key={d.sceneId}>
                  <b>Scene {d.sceneNumber}</b> <span className="dialogue-caption">“{d.caption}”</span>
                  {d.lines.map((l, j) => (
                    <span key={j} className="muted small dialogue-line">
                      {l.speaker}: {l.text}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          </div>
        )}

        {sound && (
          <div className="dialogue-plan">
            <div className="card-head">
              <span className="muted small">Music & sound design</span>
              <button className="ghost small" onClick={() => setSound(null)} aria-label="Dismiss">
                <IconX />
              </button>
            </div>
            <p className="dialogue-caption">Music: {sound.music}</p>
            <ul className="dialogue-list">
              {sound.scenes.map((s) => (
                <li key={s.sceneId}>
                  <b>Scene {s.sceneNumber}</b>
                  {s.sfx.length > 0 && <span className="muted small">SFX: {s.sfx.join(', ')}</span>}
                  {s.motif && <span className="muted small dialogue-line">Motif: {s.motif}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
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
            references={(scene.referenceCharacterIds ?? [])
              .map((id) => refByEntity.get(id))
              .filter((it): it is ReferenceReadinessItem => Boolean(it))}
          />
        ))}
        <button
          className="add-scene"
          onClick={async () => {
            const res = await run(() => api.addScene(storylineId));
            if (res) setProject(res.project);
          }}
        >
          <IconPlus /> Add scene
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
            disabled={!canPublish}
            title={canPublish ? 'Publish the short' : 'Approve every rendered clip before publishing'}
            onClick={async () => {
              if (!confirm(`Publish to YouTube (${privacy})? This uploads the short${stitch ? ' (stitched)' : ''}.`)) return;
              const res = await run(() => api.publish(storylineId, { privacyStatus: privacy, stitch }));
              if (res) {
                const p = await api.getProject(storylineId);
                setProject(p.project);
                alert(
                  res.publish.dryRun
                    ? `Dry-run publish OK (id ${res.publish.videoId}). Configure YouTube credentials for real uploads.`
                    : `Published: ${res.publish.url}`,
                );
              }
            }}
          >
            <IconSend /> Publish
          </button>
          {!canPublish && (
            <span className="gate-note">
              <IconAlert />{' '}
              {readyCount === 0 ? 'Render scenes first.' : `Approve all ${readyCount} rendered clip(s) before publishing.`}
            </span>
          )}
        </div>

        <div className="row schedule-row">
          <label className="checkbox">
            <IconClock /> Schedule for later
          </label>
          <input
            type="datetime-local"
            value={scheduleAt}
            onChange={(e) => setScheduleAt(e.target.value)}
            disabled={project.schedule?.status === 'pending'}
          />
          {project.schedule?.status === 'pending' ? (
            <>
              <span className="badge warn">
                scheduled {new Date(project.schedule.at).toLocaleString()}
              </span>
              <button
                className="ghost small"
                onClick={async () => {
                  const res = await run(() => api.cancelSchedule(storylineId));
                  if (res) {
                    const p = await api.getProject(storylineId);
                    setProject(p.project);
                  }
                }}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              className="small"
              disabled={!canPublish || !scheduleAt}
              title={canPublish ? 'Queue a publish for the chosen time' : 'Approve all clips first'}
              onClick={async () => {
                const res = await run(() =>
                  api.schedulePublish(storylineId, { at: new Date(scheduleAt).toISOString(), privacyStatus: privacy, stitch }),
                );
                if (res) {
                  const p = await api.getProject(storylineId);
                  setProject(p.project);
                  pushToast('ok', `Publish scheduled for ${new Date(res.schedule.at).toLocaleString()}.`);
                }
              }}
            >
              Schedule
            </button>
          )}
          {project.schedule && project.schedule.status !== 'pending' && (
            <span className="muted small">
              last schedule: {project.schedule.status}
              {project.schedule.error ? ` — ${project.schedule.error}` : ''}
            </span>
          )}
        </div>
        <PublishHistory project={project} />
      </section>

      {gateOpen && readiness && (
        <ApprovalGate
          readiness={readiness}
          storyId={storyId}
          config={config}
          run={run}
          pushToast={pushToast}
          onRefresh={refreshReadiness}
          onProceed={async () => {
            setGateOpen(false);
            await confirmAndRenderAll();
          }}
          onClose={() => setGateOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * Pre-render approval gate. Lists every referenced character/location that has
 * no approved reference image, lets the director approve (or generate then
 * approve) each one inline with a thumbnail, and offers an explicit
 * "generate anyway" escape hatch to render without the reference.
 */
function ApprovalGate({
  readiness,
  storyId,
  config,
  run,
  pushToast,
  onRefresh,
  onProceed,
  onClose,
}: {
  readiness: ReferenceReadiness;
  storyId: string;
  config: AppConfig;
  run: Run;
  pushToast: (kind: Toast['kind'], text: string) => void;
  onRefresh: () => Promise<ReferenceReadiness | null>;
  onProceed: () => void | Promise<void>;
  onClose: () => void;
}) {
  const unapproved = readiness.unapproved;

  return (
    <div className="lightbox-backdrop" onClick={onClose}>
      <div className="card gate-modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <h3>
            <IconAlert /> Unapproved references
          </h3>
          <button className="ghost small" onClick={onClose} aria-label="Close">
            <IconX />
          </button>
        </div>
        <p className="muted small">
          These characters/locations are used in your scenes but have no approved reference image. Rendering now falls
          back to text-only for them, which may look off-model. Approve, or tweak and preview a reference here — or
          generate anyway.
        </p>
        <ul className="gate-list">
          {unapproved.map((item) => (
            <GateItem
              key={item.entityId}
              item={item}
              storyId={storyId}
              config={config}
              run={run}
              pushToast={pushToast}
              onRefresh={onRefresh}
            />
          ))}
          {unapproved.length === 0 && <li className="drift-clean">All references are approved.</li>}
        </ul>
        <div className="row gate-footer">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="danger ghost" onClick={onProceed} title="Render without approving these references">
            Generate anyway
          </button>
          {readiness.ready && (
            <button className="primary" onClick={onProceed}>
              <IconPlay /> All approved — render
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * One unapproved reference in the gate: approve the latest version, generate a
 * fresh one, or open an inline tweak editor to preview & adjust the render
 * (prompt + params) before approving — without leaving the render flow.
 */
function GateItem({
  item,
  storyId,
  config,
  run,
  pushToast,
  onRefresh,
}: {
  item: ReferenceReadinessItem;
  storyId: string;
  config: AppConfig;
  run: Run;
  pushToast: (kind: Toast['kind'], text: string) => void;
  onRefresh: () => Promise<ReferenceReadiness | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [tweaking, setTweaking] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState(config.pixverse.models[0]);
  const [quality, setQuality] = useState(config.pixverse.qualities[0]);
  const [aspect, setAspect] = useState(config.pixverse.aspectRatios[0]);
  const [preview, setPreview] = useState<{ id: string; url: string | null; status: string } | null>(null);

  const openTweak = async () => {
    setTweaking(true);
    if (!prompt) {
      const res = await api.getReferenceDefinition(storyId, item.entityId).catch(() => null);
      if (res) setPrompt(res.definition.currentPrompt || res.definition.builtPrompt);
    }
  };

  const approveVersion = async (versionId: string) => {
    setBusy(true);
    try {
      await run(() => api.approvePortrait(storyId, item.entityId, versionId));
      await onRefresh();
      pushToast('ok', `${item.name} reference approved.`);
    } finally {
      setBusy(false);
    }
  };

  const generate = async (opts: { approve?: boolean } = {}) => {
    setBusy(true);
    try {
      const res = await run(() =>
        api.generatePortrait(storyId, item.entityId, {
          source: 'tweak',
          promptOverride: prompt || undefined,
          model,
          quality,
          aspectRatio: aspect,
        }),
      );
      if (!res) return;
      const v = res.version;
      setPreview({ id: v.id, url: v.previewUrl ?? v.imageUrl, status: v.status });
      if (opts.approve && v.status === 'ready') {
        await approveVersion(v.id);
      } else if (v.status !== 'ready') {
        pushToast('bad', `${item.name} is still rendering — approve once ready.`);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="gate-item-wrap">
      <div className="gate-item">
        <div className="gate-thumb">
          {(preview?.url ?? item.thumbnailUrl) ? (
            (preview?.url ?? item.thumbnailUrl)!.includes('.mp4') ? (
              <video src={(preview?.url ?? item.thumbnailUrl) as string} muted loop playsInline autoPlay />
            ) : (
              <img src={(preview?.url ?? item.thumbnailUrl) as string} alt={item.name} />
            )
          ) : (
            <div className="gate-thumb-empty">
              <IconImage />
            </div>
          )}
        </div>
        <div className="gate-meta">
          <b>{item.name}</b> <span className="badge plain">{item.type}</span>
          <span className="muted small">scenes {item.scenes.join(', ')}</span>
        </div>
        <div className="gate-actions">
          {item.latestVersionId && (
            <button className="small primary" disabled={busy} onClick={() => approveVersion(item.latestVersionId as string)}>
              {busy ? '…' : 'Approve'}
            </button>
          )}
          {!item.latestVersionId && (
            <button className="small" disabled={busy} onClick={() => generate({ approve: true })}>
              {busy ? 'Generating…' : 'Generate & approve'}
            </button>
          )}
          <button className="small ghost" onClick={() => (tweaking ? setTweaking(false) : openTweak())}>
            {tweaking ? 'Close' : 'Tweak'}
          </button>
        </div>
      </div>

      {tweaking && (
        <div className="gate-tweak">
          <textarea
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Reference prompt…"
          />
          <div className="row gate-tweak-params">
            <label className="global-field">
              Model
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                {config.pixverse.models.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </label>
            <label className="global-field">
              Quality
              <select value={quality} onChange={(e) => setQuality(e.target.value)}>
                {config.pixverse.qualities.map((q) => (
                  <option key={q}>{q}</option>
                ))}
              </select>
            </label>
            <label className="global-field">
              Aspect
              <select value={aspect} onChange={(e) => setAspect(e.target.value)}>
                {config.pixverse.aspectRatios.map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="row">
            <button className="small" disabled={busy} onClick={() => generate()}>
              {busy ? 'Rendering…' : 'Generate preview'}
            </button>
            {preview && preview.status === 'ready' && (
              <button className="small primary" disabled={busy} onClick={() => approveVersion(preview.id)}>
                Approve this preview
              </button>
            )}
            {preview && preview.status !== 'ready' && <span className="muted small">Rendering — {preview.status}</span>}
          </div>
        </div>
      )}
    </li>
  );
}

function PublishHistory({ project }: { project: Project }) {
  const history = [...(project.publishHistory ?? [])].reverse();
  if (history.length === 0) {
    return <p className="muted small">Not published yet.</p>;
  }
  return (
    <div className="publish-history">
      <h4 className="reference-group-head">Publish history</h4>
      <ul className="publish-list">
        {history.map((r, i) => (
          <li key={i} className="publish-row">
            <span className={`badge ${r.status === 'published' ? 'live' : r.status === 'failed' ? 'bad' : 'warn'}`}>{r.status}</span>
            {r.dryRun && <span className="badge warn">dry-run</span>}
            <span className="muted small">{r.publishedAt ? new Date(r.publishedAt).toLocaleString() : '—'}</span>
            {r.url ? (
              <a className="md-link" href={r.url} target="_blank" rel="noreferrer">
                {r.url}
              </a>
            ) : r.videoId ? (
              <span className="mono">{r.videoId}</span>
            ) : null}
            {r.error && <span className="scene-error">{r.error}</span>}
          </li>
        ))}
      </ul>
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
  const [language, setLanguage] = useState('Spanish');
  const [localizing, setLocalizing] = useState(false);
  const [variants, setVariants] = useState<TitleVariant[] | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [thumbs, setThumbs] = useState<ThumbnailConcept[] | null>(null);
  const [thumbing, setThumbing] = useState(false);

  useEffect(() => {
    setTitle(yt.title);
    setDescription(yt.description);
    setTags(yt.tags.join(', '));
    setHashtags(yt.hashtags.join(' '));
  }, [project.storyline.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="youtube-editor">
      <Field label="Title">
        <div className="row">
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} style={{ flex: 1 }} />
          <button
            className="small ghost"
            disabled={suggesting}
            title="Suggest A/B title options"
            onClick={async () => {
              setSuggesting(true);
              try {
                const res = await run(() => api.titleVariants(storylineId, { count: 5 }));
                if (res) setVariants(res.variants);
              } finally {
                setSuggesting(false);
              }
            }}
          >
            {suggesting ? '…' : 'A/B titles'}
          </button>
        </div>
      </Field>
      {variants && variants.length > 0 && (
        <ul className="title-variants">
          {variants.map((v, i) => (
            <li key={i}>
              <button className="link" onClick={() => setTitle(v.title)} title="Use this title">
                {v.title}
              </button>
              <span className="muted small">{v.angle}</span>
            </li>
          ))}
        </ul>
      )}
      {thumbs && thumbs.length > 0 && (
        <ul className="title-variants">
          {thumbs.map((t, i) => (
            <li key={i}>
              <b>“{t.overlayText}”</b>
              <span className="muted small">scene {t.sceneNumber} · {t.framing} — {t.rationale}</span>
            </li>
          ))}
        </ul>
      )}
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
      <div>
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
        <button
          className="ghost"
          disabled={thumbing}
          title="Suggest A/B thumbnail concepts (overlay text + framing)"
          onClick={async () => {
            setThumbing(true);
            try {
              const res = await run(() => api.thumbnailConcepts(storylineId, { count: 4 }));
              if (res) setThumbs(res.concepts);
            } finally {
              setThumbing(false);
            }
          }}
        >
          {thumbing ? 'Thinking…' : 'Thumbnail ideas'}
        </button>
        <span className="global-sep" />
        <input
          className="lang-input"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          placeholder="Language"
          title="Target language for localization"
        />
        <button
          className="ghost"
          disabled={localizing || !language.trim()}
          title="Translate the title, description, tags and hashtags into this language (preview into the fields)"
          onClick={async () => {
            setLocalizing(true);
            try {
              const res = await run(() => api.localizeYoutube(storylineId, language.trim()));
              if (res) {
                setTitle(res.youtube.title);
                setDescription(res.youtube.description);
                setTags(res.youtube.tags.join(', '));
                setHashtags(res.youtube.hashtags.join(' '));
              }
            } finally {
              setLocalizing(false);
            }
          }}
        >
          {localizing ? 'Localizing…' : 'Localize'}
        </button>
      </div>
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
