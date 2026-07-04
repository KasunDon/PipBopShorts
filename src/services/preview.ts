import { collectValidationIssues } from '../clients/pixverse';
import { createPixverseProvider, formatUsd, type MediaProvider } from '../costs/pricing';
import type { Store } from '../store/store';
import { currentCanonVersion } from './canon';
import { buildStorylineContext } from './storyline';

export interface PreviewCheck {
  level: 'ok' | 'warn' | 'error';
  message: string;
}

export interface StorylinePreview {
  /** The exact context markdown that will be sent to the AI to generate the storyline. */
  markdown: string;
  checks: PreviewCheck[];
  /** Whether generation is safe to proceed (no errors). */
  ok: boolean;
}

/**
 * Assemble a human-readable preview of everything the AI will receive to
 * generate an episode's storyline — the story bible, the episode brief, any
 * per-episode setting, and the production constraints — plus pre-flight checks
 * so the user can review and fix inputs before spending an LLM call.
 */
export function buildStorylinePreview(store: Store, storyId: string, episodeId: string): StorylinePreview {
  const story = store.getStory(storyId);
  const episode = store.getEpisode(episodeId);
  const { bible, settingOverride } = buildStorylineContext(store, storyId, episodeId);
  const canon = currentCanonVersion(store.getCanonRegistry(storyId));

  const parts: string[] = [];
  parts.push(`# Story: ${story.title}`);
  if (story.meta.audienceMin != null || story.meta.audienceMax != null) {
    parts.push(`Audience: ages ${story.meta.audienceMin ?? '?'}–${story.meta.audienceMax ?? '?'} ${story.meta.audienceNotes}`.trim());
  }
  if (story.meta.genres.length) parts.push(`Genres: ${story.meta.genres.join(', ')}`);
  if (story.meta.tones.length) parts.push(`Tone: ${story.meta.tones.join(', ')}`);

  parts.push('\n# Story bible');
  parts.push(bible.trim() || '(empty)');

  if (settingOverride) {
    parts.push('\n# Episode-specific setting (overrides the bible)');
    parts.push(settingOverride.trim());
  }

  parts.push('\n# Episode');
  parts.push(`Title: ${episode.title}`);
  parts.push(`Brief: ${episode.brief.trim() || '(empty)'}`);

  if (canon) {
    const characters = canon.entities.filter((e) => e.type === 'character').map((e) => e.name);
    const locations = canon.entities.filter((e) => e.type === 'location').map((e) => e.name);
    parts.push(`\n# Canon (v${canon.version}) — the storyline will be generated against these`);
    if (characters.length) parts.push(`Characters: ${characters.join(', ')}`);
    if (locations.length) parts.push(`Locations: ${locations.join(', ')}`);
  }

  const checks: PreviewCheck[] = [];
  if (!bible.trim()) {
    checks.push({ level: 'error', message: 'Story bible is empty — write the bible before generating.' });
  } else if (bible.trim().length < 200) {
    checks.push({ level: 'warn', message: 'Story bible is very short; the storyline may lack detail.' });
  } else {
    checks.push({ level: 'ok', message: 'Story bible present.' });
  }

  if (!episode.brief.trim()) {
    checks.push({ level: 'warn', message: 'Episode brief is empty — the AI has little to work from.' });
  } else {
    checks.push({ level: 'ok', message: 'Episode brief present.' });
  }

  if (story.settingMode === 'per-episode' && !settingOverride) {
    checks.push({ level: 'warn', message: 'Per-episode mode but no episode setting — the bible setting will be used.' });
  }

  if (!canon) {
    checks.push({
      level: 'warn',
      message: 'No canon extracted — the storyline will not be consistency-checked against canon. Extract canon first for best results.',
    });
  } else {
    checks.push({ level: 'ok', message: `Canon v${canon.version} available for consistency.` });
  }

  return { markdown: parts.join('\n'), checks, ok: !checks.some((c) => c.level === 'error') };
}

export interface SceneValidation {
  sceneId: string;
  heading: string;
  issues: string[];
  estCredits: number;
  estUsd: number;
}

export interface RenderValidation {
  scenes: SceneValidation[];
  totalCredits: number;
  totalUsd: number;
  estUsdLabel: string;
  /** Sum of scene durations = the stitched short's total length (PixVerse renders 5s/8s clips). */
  totalDurationSec: number;
  /** No scene has blocking validation issues. */
  ok: boolean;
  invalidCount: number;
}

/**
 * Validate every scene of a storyline against PixVerse's parameter rules and
 * estimate the render cost — run before committing credits to a full render so
 * the user sees both what will fail and what it will cost.
 */
export function validateStorylineForRender(
  store: Store,
  storylineId: string,
  provider: MediaProvider = createPixverseProvider(),
): RenderValidation {
  const project = store.getProject(storylineId);
  const scenes = [...project.storyline.scenes].sort((a, b) => a.order - b.order);
  let totalCredits = 0;
  let totalUsd = 0;
  let totalDurationSec = 0;
  let invalidCount = 0;

  const results: SceneValidation[] = scenes.map((scene) => {
    const issues = collectValidationIssues(
      {
        prompt: scene.prompt,
        model: scene.model,
        quality: scene.quality,
        duration: scene.duration,
        motionMode: scene.motionMode,
        aspectRatio: scene.aspectRatio,
        negativePrompt: scene.negativePrompt,
        style: scene.style,
        cameraMovement: scene.cameraMovement,
        imageId: scene.imageId,
      },
      { requireImage: typeof scene.imageId === 'number' },
    );
    if (issues.length) invalidCount += 1;
    const cost = provider.price({
      kind: 'video',
      model: scene.model,
      quality: scene.quality,
      durationSec: scene.duration,
      motionMode: scene.motionMode,
    });
    totalCredits += cost.credits ?? 0;
    totalUsd += cost.usd;
    totalDurationSec += Number(scene.duration) || 0;
    return { sceneId: scene.id, heading: scene.heading, issues, estCredits: cost.credits ?? 0, estUsd: cost.usd };
  });

  return {
    scenes: results,
    totalCredits,
    totalUsd,
    estUsdLabel: formatUsd(totalUsd),
    totalDurationSec,
    ok: invalidCount === 0,
    invalidCount,
  };
}
