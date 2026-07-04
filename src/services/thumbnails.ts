import { structuredCall, type AnthropicLike } from '../clients/claude';
import type { ClaudeEffort } from '../constants';
import type { Store } from '../store/store';

const THUMBS_SYSTEM = `You are a Shorts thumbnail director designing click-worthy thumbnail concepts.
For each concept: the big overlay TEXT (very few words, punchy), the FRAMING (what's on screen — subject, expression, composition), which scene it should freeze, and a one-line rationale for the hook. Stay honest to the content and appropriate for the audience; keep overlay text short enough to read on a phone.`;

function thumbsSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      concepts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            overlay_text: { type: 'string' },
            framing: { type: 'string' },
            scene_number: { type: 'integer' },
            rationale: { type: 'string' },
          },
          required: ['overlay_text', 'framing', 'scene_number', 'rationale'],
        },
      },
    },
    required: ['concepts'],
  };
}

export interface ThumbnailConcept {
  overlayText: string;
  framing: string;
  sceneNumber: number;
  rationale: string;
}

export interface ThumbnailOptions {
  count?: number;
  model?: string;
  effort?: ClaudeEffort;
}

/** Suggest A/B thumbnail concepts (overlay text + framing + which scene) for a Short. */
export async function suggestThumbnailConcepts(
  store: Store,
  claude: AnthropicLike,
  storylineId: string,
  options: ThumbnailOptions = {},
): Promise<ThumbnailConcept[]> {
  const project = store.getProject(storylineId);
  const story = store.getStory(project.storyline.storyId);
  const scenes = [...project.storyline.scenes].sort((a, b) => a.order - b.order);
  const count = Math.min(Math.max(options.count ?? 4, 1), 10);

  const user = [
    `# SHORT`,
    `Logline: ${project.storyline.logline}`,
    story.meta.audienceMin != null || story.meta.audienceMax != null
      ? `Audience: ages ${story.meta.audienceMin ?? '?'}–${story.meta.audienceMax ?? '?'}`
      : '',
    story.meta.tones.length ? `Tone: ${story.meta.tones.join(', ')}` : '',
    `\n# SCENES`,
    ...scenes.map((s, i) => `${i + 1}. ${s.heading} — ${s.prompt}`),
    `\n# TASK\nPropose ${count} distinct thumbnail concepts.`,
  ]
    .filter(Boolean)
    .join('\n');

  const { json } = await structuredCall(claude, {
    model: options.model ?? 'claude-sonnet-5',
    effort: options.effort ?? 'low',
    system: THUMBS_SYSTEM,
    user,
    schema: thumbsSchema(),
    maxTokens: 2000,
  });

  const raw = (json as { concepts?: Array<{ overlay_text: string; framing: string; scene_number: number; rationale: string }> }).concepts ?? [];
  return raw.slice(0, count).map((c) => ({
    overlayText: c.overlay_text,
    framing: c.framing,
    sceneNumber: c.scene_number,
    rationale: c.rationale,
  }));
}
