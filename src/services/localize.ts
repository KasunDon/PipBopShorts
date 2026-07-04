import { structuredCall, type AnthropicLike } from '../clients/claude';
import type { ClaudeEffort } from '../constants';
import { UserInputError } from '../errors';
import type { Store } from '../store/store';
import type { YoutubeMeta } from '../types';

const LOCALIZE_SYSTEM = `You localize a YouTube Short's marketing metadata into a target language.
Translate the title and description naturally (not literally) so they read like native marketing copy, keep them within YouTube limits (title ≤ 100 chars), and localize tags and hashtags where it helps discovery while keeping widely-recognized ones. Preserve meaning, tone, and any brand/character names.`;

function localizeSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      hashtags: { type: 'array', items: { type: 'string' } },
    },
    required: ['title', 'description', 'tags', 'hashtags'],
  };
}

export interface LocalizeOptions {
  model?: string;
  effort?: ClaudeEffort;
}

/** Produce a localized variant of a storyline's YouTube metadata (does not persist it). */
export async function localizeYoutubeMeta(
  store: Store,
  claude: AnthropicLike,
  storylineId: string,
  language: string,
  options: LocalizeOptions = {},
): Promise<YoutubeMeta> {
  if (!language || !language.trim()) throw new UserInputError('Target language is required.');
  const project = store.getProject(storylineId);
  const meta = project.storyline.youtube;

  const user = [
    `# TARGET LANGUAGE\n${language.trim()}`,
    `\n# SOURCE METADATA`,
    `Title: ${meta.title}`,
    `Description: ${meta.description}`,
    `Tags: ${meta.tags.join(', ')}`,
    `Hashtags: ${meta.hashtags.join(' ')}`,
  ].join('\n');

  const { json } = await structuredCall(claude, {
    model: options.model ?? 'claude-sonnet-5',
    effort: options.effort ?? 'low',
    system: LOCALIZE_SYSTEM,
    user,
    schema: localizeSchema(),
    maxTokens: 2000,
  });

  const raw = json as YoutubeMeta;
  return {
    title: raw.title ?? meta.title,
    description: raw.description ?? meta.description,
    tags: raw.tags ?? meta.tags,
    hashtags: raw.hashtags ?? meta.hashtags,
  };
}
