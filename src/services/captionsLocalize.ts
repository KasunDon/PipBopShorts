import { structuredCall, type AnthropicLike } from '../clients/claude';
import type { ClaudeEffort } from '../constants';
import { UserInputError } from '../errors';
import type { Store } from '../store/store';
import { buildSrt, captionEntries } from './captions';

const CAPTIONS_SYSTEM = `You translate short-form video captions for burned-in subtitles.
Translate each caption naturally into the target language, keeping it punchy and short enough to read on a phone. Preserve order and count exactly — return one translation per input caption (empty string for an empty input).`;

function schema(count: number) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      captions: { type: 'array', items: { type: 'string' }, minItems: count, maxItems: count },
    },
    required: ['captions'],
  };
}

export interface LocalizeCaptionsOptions {
  model?: string;
  effort?: ClaudeEffort;
}

/** Localize a storyline's captions into a target language and return a timed SRT. */
export async function localizeCaptionsSrt(
  store: Store,
  claude: AnthropicLike,
  storylineId: string,
  language: string,
  options: LocalizeCaptionsOptions = {},
): Promise<string> {
  if (!language || !language.trim()) throw new UserInputError('Target language is required.');
  const entries = captionEntries(store, storylineId);
  const captions = entries.map((e) => e.caption);
  if (!captions.some((c) => c.trim())) {
    throw new UserInputError('No captions to localize — run "Dialogue & captions" first.');
  }

  const user = [
    `# TARGET LANGUAGE\n${language.trim()}`,
    `\n# CAPTIONS (translate each, keep order and count)`,
    ...captions.map((c, i) => `${i + 1}. ${c || '(empty)'}`),
  ].join('\n');

  const { json } = await structuredCall(claude, {
    model: options.model ?? 'claude-sonnet-5',
    effort: options.effort ?? 'low',
    system: CAPTIONS_SYSTEM,
    user,
    schema: schema(captions.length),
    maxTokens: 3000,
  });

  const translated = (json as { captions?: string[] }).captions ?? [];
  const localizedEntries = entries.map((e, i) => ({
    caption: translated[i] ?? e.caption,
    durationSec: e.durationSec,
  }));
  return buildSrt(localizedEntries);
}
