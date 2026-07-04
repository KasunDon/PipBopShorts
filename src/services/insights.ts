import { structuredCall, type AnthropicLike } from '../clients/claude';
import type { ClaudeEffort } from '../constants';
import { UserInputError } from '../errors';
import type { Store } from '../store/store';

const INSIGHTS_SYSTEM = `You are a growth analyst reviewing a series' published shorts and their real performance.
Look for what correlates with higher views/retention across the shorts (hooks, title style, subject, tone, pacing) and what underperforms. Be concrete and honest — only claim patterns the data supports, and say when the sample is too small to be sure.
Return a few specific findings and one actionable recommendation to feed back into the story formula.`;

function insightsSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      findings: { type: 'array', items: { type: 'string' } },
      recommendation: { type: 'string' },
      confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    },
    required: ['findings', 'recommendation', 'confidence'],
  };
}

export interface PerformanceInsights {
  findings: string[];
  recommendation: string;
  confidence: 'low' | 'medium' | 'high';
  sampleSize: number;
}

export interface InsightsOptions {
  model?: string;
  effort?: ClaudeEffort;
}

/** Analyse a story's published shorts + recorded performance to suggest story-formula tweaks. */
export async function analyzePerformance(
  store: Store,
  claude: AnthropicLike,
  storyId: string,
  options: InsightsOptions = {},
): Promise<PerformanceInsights> {
  store.getStory(storyId);
  const shorts = store
    .listProjects()
    .filter((p) => p.storyline.storyId === storyId && p.performance && (p.performance.views ?? 0) >= 0);
  if (shorts.length === 0) {
    throw new UserInputError('No performance recorded yet — log views/retention on published shorts first.');
  }

  const rows = shorts
    .sort((a, b) => (b.performance?.views ?? 0) - (a.performance?.views ?? 0))
    .map((p) => {
      const perf = p.performance!;
      return `- "${p.storyline.youtube.title || p.storyline.title}" — ${perf.views} views${perf.retentionPct != null ? `, ${perf.retentionPct}% retention` : ''}${perf.likes != null ? `, ${perf.likes} likes` : ''}. Logline: ${p.storyline.logline}`;
    });

  const { json } = await structuredCall(claude, {
    model: options.model ?? 'claude-sonnet-5',
    effort: options.effort ?? 'low',
    system: INSIGHTS_SYSTEM,
    user: [`# PUBLISHED SHORTS (${shorts.length}) — sorted by views`, ...rows].join('\n'),
    schema: insightsSchema(),
    maxTokens: 2000,
  });

  const raw = json as { findings?: string[]; recommendation?: string; confidence?: 'low' | 'medium' | 'high' };
  return {
    findings: raw.findings ?? [],
    recommendation: raw.recommendation ?? '',
    confidence: raw.confidence ?? 'low',
    sampleSize: shorts.length,
  };
}
