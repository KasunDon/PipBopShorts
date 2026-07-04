import { structuredCall, type AnthropicLike } from '../clients/claude';
import type { ClaudeEffort } from '../constants';
import { UserInputError } from '../errors';
import type { Store } from '../store/store';
import { buildCanonBlock, currentCanonVersion, DEFAULT_DISSECT_MODEL } from './canon';
import { buildStorylineContext } from './storyline';

const BEATSHEET_SYSTEM = `You are a structural story editor building a BEAT SHEET for one short episode.
Break the episode into a tight sequence of beats that carry a satisfying mini-arc for the format and audience: a hook, escalating complications, a turn, a climax, and a resolution — adjust the exact beats to the story.
For each beat give a short name, one or two sentences of what happens, and its purpose (why it earns its place). Stay consistent with canon and the declared tone; keep it appropriate for the audience.`;

function beatSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      beats: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            purpose: { type: 'string' },
          },
          required: ['name', 'description', 'purpose'],
        },
      },
    },
    required: ['beats'],
  };
}

export interface Beat {
  name: string;
  description: string;
  purpose: string;
}

export interface BeatSheetOptions {
  model?: string;
  effort?: ClaudeEffort;
}

/** Generate a structural beat sheet for an episode, grounded in its bible/brief/setting + canon. */
export async function generateBeatSheet(
  store: Store,
  claude: AnthropicLike,
  storyId: string,
  episodeId: string,
  options: BeatSheetOptions = {},
): Promise<Beat[]> {
  const story = store.getStory(storyId);
  const episode = store.getEpisode(episodeId);
  const { bible, settingOverride } = buildStorylineContext(store, storyId, episodeId);
  if (!bible.trim() && !episode.brief.trim()) {
    throw new UserInputError('Write the bible or an episode brief before generating a beat sheet.');
  }
  const canon = currentCanonVersion(store.getCanonRegistry(storyId));

  const user = [
    `# STORY: ${story.title}`,
    story.meta.audienceMin != null || story.meta.audienceMax != null
      ? `Audience: ages ${story.meta.audienceMin ?? '?'}–${story.meta.audienceMax ?? '?'}`
      : '',
    story.meta.tones.length ? `Tone: ${story.meta.tones.join(', ')}` : '',
    `\n# EPISODE: ${episode.title}`,
    `Brief: ${episode.brief.trim() || '(none)'}`,
    settingOverride ? `Setting: ${settingOverride.trim()}` : '',
    canon ? `\n# CANON\n${buildCanonBlock(canon)}` : '',
    '\n# TASK\nProduce the episode beat sheet.',
  ]
    .filter(Boolean)
    .join('\n');

  const { json } = await structuredCall(claude, {
    model: options.model ?? DEFAULT_DISSECT_MODEL,
    effort: options.effort ?? 'medium',
    system: BEATSHEET_SYSTEM,
    user,
    schema: beatSchema(),
    maxTokens: 6000,
  });

  return (json as { beats?: Beat[] }).beats ?? [];
}
