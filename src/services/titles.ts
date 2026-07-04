import { structuredCall, type AnthropicLike } from '../clients/claude';
import type { ClaudeEffort } from '../constants';
import type { Store } from '../store/store';

const TITLES_SYSTEM = `You are a YouTube Shorts growth editor writing A/B title options.
Given a short's logline and current metadata, propose distinct, punchy alternative titles that would earn the click while staying honest to the content and appropriate for the audience.
Each option takes a different marketing ANGLE (curiosity, stakes, character, humour, payoff…). Keep every title ≤ 100 characters. Do not clickbait beyond what the video delivers.`;

function titlesSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      variants: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string' },
            angle: { type: 'string' },
          },
          required: ['title', 'angle'],
        },
      },
    },
    required: ['variants'],
  };
}

export interface TitleVariant {
  title: string;
  angle: string;
}

export interface TitleVariantsOptions {
  count?: number;
  model?: string;
  effort?: ClaudeEffort;
}

/** Suggest A/B title options for a storyline's Short, grounded in its logline + metadata. */
export async function suggestTitleVariants(
  store: Store,
  claude: AnthropicLike,
  storylineId: string,
  options: TitleVariantsOptions = {},
): Promise<TitleVariant[]> {
  const project = store.getProject(storylineId);
  const story = store.getStory(project.storyline.storyId);
  const meta = project.storyline.youtube;
  const count = Math.min(Math.max(options.count ?? 5, 1), 12);

  const user = [
    `# SHORT`,
    `Logline: ${project.storyline.logline}`,
    `Current title: ${meta.title}`,
    meta.description ? `Description: ${meta.description}` : '',
    story.meta.audienceMin != null || story.meta.audienceMax != null
      ? `Audience: ages ${story.meta.audienceMin ?? '?'}–${story.meta.audienceMax ?? '?'}`
      : '',
    story.meta.tones.length ? `Tone: ${story.meta.tones.join(', ')}` : '',
    `\n# TASK\nWrite ${count} distinct A/B title options, each with its angle.`,
  ]
    .filter(Boolean)
    .join('\n');

  const { json } = await structuredCall(claude, {
    model: options.model ?? 'claude-sonnet-5',
    effort: options.effort ?? 'low',
    system: TITLES_SYSTEM,
    user,
    schema: titlesSchema(),
    maxTokens: 2000,
  });

  return ((json as { variants?: TitleVariant[] }).variants ?? []).slice(0, count);
}
