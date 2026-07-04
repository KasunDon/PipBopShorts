import { structuredCall, type AnthropicLike } from '../clients/claude';
import type { ClaudeEffort } from '../constants';
import { UserInputError } from '../errors';
import type { Store } from '../store/store';
import { buildCanonBlock, currentCanonVersion, DEFAULT_DISSECT_MODEL } from './canon';

const IDEAS_SYSTEM = `You are a series story editor brainstorming FUTURE episode ideas for an ongoing show.
Propose fresh, distinct episode concepts that fit the established world, characters, tone, and audience — never contradicting canon, never repeating an existing episode.
Each idea has a punchy title, a one-line hook (the promise of the episode), and a 2–3 sentence synopsis. Keep them appropriate for the declared audience.`;

function ideasSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      ideas: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string' },
            hook: { type: 'string' },
            synopsis: { type: 'string' },
          },
          required: ['title', 'hook', 'synopsis'],
        },
      },
    },
    required: ['ideas'],
  };
}

export interface EpisodeIdea {
  title: string;
  hook: string;
  synopsis: string;
}

export interface SuggestIdeasOptions {
  count?: number;
  model?: string;
  effort?: ClaudeEffort;
}

/** Generate a backlog of future episode ideas grounded in the story's bible + canon. */
export async function suggestEpisodeIdeas(
  store: Store,
  claude: AnthropicLike,
  storyId: string,
  options: SuggestIdeasOptions = {},
): Promise<EpisodeIdea[]> {
  const story = store.getStory(storyId);
  const bible = store.getBible(storyId);
  if (!bible.trim()) throw new UserInputError('Write the story bible before brainstorming episode ideas.');

  const count = Math.min(Math.max(options.count ?? 6, 1), 20);
  const canon = currentCanonVersion(store.getCanonRegistry(storyId));
  const existing = store.listEpisodes(storyId);

  const user = [
    `# STORY: ${story.title}`,
    story.meta.audienceMin != null || story.meta.audienceMax != null
      ? `Audience: ages ${story.meta.audienceMin ?? '?'}–${story.meta.audienceMax ?? '?'}`
      : '',
    story.meta.tones.length ? `Tone: ${story.meta.tones.join(', ')}` : '',
    story.meta.genres.length ? `Genres: ${story.meta.genres.join(', ')}` : '',
    story.plan?.arcSummary ? `Season arc: ${story.plan.arcSummary}` : '',
    '\n# STORY BIBLE',
    bible.trim(),
    canon ? `\n# CANON (do not contradict)\n${buildCanonBlock(canon)}` : '',
    existing.length
      ? `\n# EXISTING EPISODES (do not repeat these)\n${existing.map((e) => `- ${e.title}${e.brief ? `: ${e.brief}` : ''}`).join('\n')}`
      : '',
    `\n# TASK\nPropose ${count} distinct new episode ideas.`,
  ]
    .filter(Boolean)
    .join('\n');

  const { json } = await structuredCall(claude, {
    model: options.model ?? DEFAULT_DISSECT_MODEL,
    effort: options.effort ?? 'medium',
    system: IDEAS_SYSTEM,
    user,
    schema: ideasSchema(),
    maxTokens: 6000,
  });

  return ((json as { ideas?: EpisodeIdea[] }).ideas ?? []).slice(0, count);
}
