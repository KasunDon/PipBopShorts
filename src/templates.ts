import type { StoryMeta } from './types';

/**
 * Generic .md templates that structure a story so every vital detail a
 * video-generation AI needs is captured in a predictable place. The section
 * headings are also what the canon extractor keys on, so filling the template
 * yields a much richer canon registry.
 */

function audienceLabel(meta?: Partial<StoryMeta>): string {
  if (meta?.audienceMin != null && meta?.audienceMax != null) {
    return `Ages ${meta.audienceMin}–${meta.audienceMax}`;
  }
  return 'e.g. Ages 4–7, teens, general';
}

export function storyBibleTemplate(title = 'Untitled Story', meta?: Partial<StoryMeta>): string {
  const genres = meta?.genres?.length ? meta.genres.join(', ') : 'e.g. comedy, sci-fi, adventure';
  const tones = meta?.tones?.length ? meta.tones.join(', ') : 'e.g. cheerful, warm, safe, energetic';
  const format = meta?.format || 'e.g. 3D animated comedy shorts';
  const length = meta?.episodeLengthSec != null ? `~${meta.episodeLengthSec} seconds` : '~60 seconds (Shorts)';

  return `---
title: "${title}"
audience: "${audienceLabel(meta)}"
genres: "${genres}"
tone: "${tones}"
format: "${format}"
episode_length: "${length}"
version: "1.0"
---

# ${title} — Story Bible

## 1. Premise
One or two paragraphs: what is this series about, what makes it special, and
what feeling should every episode leave the viewer with?

> **Core promise:** one sentence a viewer would use to describe the series.

## 2. Audience & Tone
- **Audience:** ${audienceLabel(meta)} — what do they love, what must we avoid?
- **Tone:** ${tones}
- **Content rules:** list what is always OK and what is never allowed
  (violence, fear, sarcasm, etc.). Be explicit — these become safety rails.

## 3. World / Setting
Describe the world as if briefing a cinematographer:
- Where and when does the story happen?
- **World rules:** what is possible here that isn't in reality? What is NOT possible?
- Scale, geography, recurring weather/time-of-day.

### Visual palette
- Colors to USE:
- Colors/moods to AVOID:

### Lighting
Default lighting mood (e.g. warm morning sun, soft shadows, no harsh darkness).

## 4. Main Characters
Repeat this block for each character. The **Visual signature** is what the
video AI repeats in every prompt — make it concrete and unmistakable.

### <Character Name>
- **Role:** (e.g. energetic comic lead)
- **Personality:** 3–6 adjectives plus one flaw that drives comedy/drama.
- **Visual signature:** species/build, colors, eyes, distinctive accessory,
  proportions — one paragraph a stranger could paint from.
- **Movement style:** how they move, signature gestures.
- **Voice:** tone, pace, quirks.
- **Catchphrases:** 2–5 short lines.
- **Never change:** the details that must stay identical in every episode
  (accessory, colors, species…). These become LOCKED consistency marks.

## 5. Relationships
How do the characters interact? Which pairs create the best scenes and why?
- **<A> + <B>:** dynamic, typical beats.

## 6. Recurring Locations
Repeat per location.

### <Location Name>
- **Look:** key landmarks, colors, props that are always present.
- **Best used for:** the kinds of beats that shine here.
- **Never change:** fixed landmarks / layout facts.

## 7. Story Formula
The repeatable structure of an episode (beats + rough timing). Example:
1. Visual hook
2. Simple goal
3. Obstacle & funny attempts
4. Biggest (harmless) accident
5. Resolution together
6. Memorable final beat

## 8. Visual & Camera Style
- Animation/render style (e.g. rounded stylized 3D, soft cinematic lighting).
- Approved camera moves and shot types; editing pace.
- Facial-expression rules (approved and forbidden expressions).

## 9. Do / Don't (Safety Rails)
**Always:**
- …

**Never:**
- … (this list is merged into every generation's negative prompt)

## 10. Consistency Prompt Reference
One ready-to-paste paragraph per character/location that a video model can
consume directly. Keep these in sync with section 4/6.

> <Character Name>: <full visual description in one paragraph, including style
> line such as "rounded, child-friendly 3D animation, bright colors, soft
> cinematic lighting">.
`;
}

export function episodeSettingTemplate(episodeTitle = 'Untitled Episode'): string {
  return `# ${episodeTitle} — Episode Setting

This file overrides/extends the story bible **for this episode only**.

## Setting for this episode
Where does this episode take place? What is different from the default world?

## One-off characters or props
Describe any character, creature, or object that appears only in this episode
(visual signature included).

## Mood & lighting for this episode
If different from the bible's defaults.

## Special world rules in effect
Temporary rules (e.g. "everything floats today") and what stays unchanged.

## Must keep consistent
Facts from the bible that absolutely still apply here.
`;
}
