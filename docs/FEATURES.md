# Backlot — feature inventory & console redesign

**Backlot** is the platform's name (formerly *PipBopShorts*). In film production, the
backlot is a studio's collection of standing sets, preserved and reused across
productions. That is exactly this platform's guiding principle — *"treat every approved
output as an existing film set."* Canon, reference images, and templates are the
standing sets; episodes are shot on them.

This document is (1) the complete feature inventory, (2) the UX audit that motivated the
redesign, and (3) the design system the console now follows.

---

## 1. Feature inventory

### Story development
| Feature | Where | Backend |
| --- | --- | --- |
| Bootstrap a whole series from a one-line idea (title, metadata, full bible, optional canon) | Home → "Create series" | `POST /api/stories/bootstrap` |
| Manual story creation (shared or per-episode setting mode) | Sidebar → New story | `POST /api/stories` |
| Story bible editing with canonical template + rendered preview | Story → Bible tab | `GET/PUT /api/stories/:id/bible`, templates |
| Production metadata (audience age, genres, tones, format, runtime) | Story → Settings tab | `PATCH /api/stories/:id` |
| Portable export/import (`.story.md` package: bible, episodes, canon, storylines) | Story → Settings / Sidebar → Import | `GET /:id/export`, `POST /api/stories/import` |

### Canon & consistency (the continuity supervisor)
| Feature | Where | Backend |
| --- | --- | --- |
| Extract bible → version-controlled canon registry (characters, locations, props, relationships, world rules, visual style, audience/tone marks with `locked/strong/flexible` severity) | Story → Canon tab | `POST /:id/canon/extract` |
| Canon history, per-mark manual edit, transition completion | Story → Canon tab | `PATCH .../marks/:key` |
| Drift check of any storyline against canon; resolve per finding: reject / accept now / accept gradually | Production → Consistency | `POST /:id/drift-check`, `.../resolve` |

### Reference images (characters, locations & settings)
| Feature | Where | Backend |
| --- | --- | --- |
| Versioned reference registry synced from canon (survives canon re-extraction via base-id migration) | Story → References tab | `GET /:id/characters` |
| Definition view: canon marks + the exact render prompt, editable before generating | References → Definition | `GET .../definition` |
| Generate / refresh / tweak (prompt and/or seed image → image-to-video) / upload still; approve one version | References tab | `POST .../portraits`, `.../approve`, `.../still` |
| Bulk "render all missing" with confirmation | References tab header | loops `POST .../portraits` |
| Still auto-captured from each render (bundled ffmpeg) and re-uploaded as an image-to-video source; capture failures surfaced | automatic | `frame.ts` |
| Approved references auto-attached to scenes that name the character | automatic | `resolveSceneReferences` |

### Episodes & season planning
| Feature | Where | Backend |
| --- | --- | --- |
| Add episode (manual, or AI-drafted from an idea); per-episode setting override; runtime targets | Story → Episodes tab | `POST /:id/episodes`, `POST .../draft` |
| Random (episodic) mode: generate next standalone episode | Story → Season tab | `POST .../episodes/generate` |
| Linear mode: plan a season arc, generate planned episodes in order, extend the season | Story → Season tab | `POST /:id/plan`, `/plan/extend` |

### Script compilation & storyline generation
| Feature | Where | Backend |
| --- | --- | --- |
| **Compile the episode script** — the exact context the AI receives (bible + setting + brief + canon) with pre-flight checks, **rendered as markdown** | Episode → step 1 | `GET .../storyline-preview` |
| **Review gate:** storyline generation is disabled until the compiled script has been reviewed and has no blocking issues | Episode → step 2 | client-side gate |
| Generate the shot-by-shot storyline (model + effort picker, scene count, PixVerse defaults, guidance) | Episode → step 2 | `POST .../storylines` |

### Production (rendering)
| Feature | Where | Backend |
| --- | --- | --- |
| Per-scene editing: prompt, negative prompt, duration, aspect, model, quality, motion, style, camera; reference image upload | Production → scene cards | `PATCH .../scenes/:id` |
| **Validate & estimate:** every scene checked against PixVerse rules + credit/USD estimate + total runtime, **required before "Render all"** | Production header | `GET .../validate` |
| Render one / all scenes (confirmation on every credit spend), poll, re-render, extend | Production | `POST .../generate` etc. |
| Scene add / remove / reorder; editing a scene resets only that scene's clip | Production | storyline routes |

### Publishing
| Feature | Where | Backend |
| --- | --- | --- |
| YouTube metadata editor; publish (private/unlisted/public) with optional ffmpeg stitch; dry-run until credentials exist | Production → Publish | `POST .../publish` |
| Publish history — every attempt recorded as an immutable snapshot | Production → Publish | `Project.publishHistory` |

### Operations (admin)
| Feature | Where | Backend |
| --- | --- | --- |
| Cost report: total / **exact (billed)** vs **estimated**, by provider, kind, model, phase, story, episode; token usage | Sidebar → Costs | `GET /api/costs/report` |
| Penny-by-penny line items per story (audit ledger) | Costs → row drill-down | `GET /api/costs/events` |
| Audit log of every outbound network call (LLM + PixVerse + YouTube), searchable, live SSE stream, full raw request/response, per-call cost | Sidebar → Activity | `/api/events*` |
| **Data-mutation audit** (`store` events) on every delete/update with the **old value preserved** + a readable before→after field diff | Sidebar → Activity (filter `store`) | recorded on delete/update routes |
| **Restore-from-audit (fail-safe)** — one-click rehydrate a deleted story / episode / storyline / scene from its preserved snapshot | Activity → expand a `*.delete` event → Restore | `POST /api/audit/:eventId/restore` |

### Added since the redesign (production ergonomics, planning & distribution)
| Feature | Where | Backend |
| --- | --- | --- |
| **Async background renders** — submit-and-forget clips/portraits; a server-side runner polls to completion (survives tab close + restart), SSE notifications, de-dupe | automatic; toasts + pending chip | `JobRunner`, `/api/jobs`, `/api/jobs/stream` |
| **LLM auto-fix** of render-parameter issues — creatively-appropriate fixes using full story+canon context, never touches the prompt; deterministic fallback | Production → validation box → "Fix all issues automatically" | `POST /:id/autofix` |
| **Tone & child-safety consistency** — drift checks audit tone + audience metadata; `consistency`/`safety` categories; strict CHILD-SAFETY mode ≤ 12 | Production → Consistency | `POST /:id/drift-check` |
| **Directed scene patch** ("change one thing, preserve everything else") with per-scene patch history | each scene card → directed-edit box | `POST /:id/scenes/:sid/patch` |
| **Scene review comments** (add / resolve / delete; never touches the render) | each scene card | `.../comments*` |
| **Clip approval workflow** — per-clip approve/unapprove (reset on edit); **publish gated** on all clips approved | scene card → Approve; publish gate | `POST /:id/scenes/:sid/clip/approval` |
| **Pre-render approval gate** — warns on unapproved referenced characters/locations with thumbnails; approve / generate-&-approve / **tweak-then-approve** inline, or generate anyway | "Render all" → modal | `GET /:id/reference-readiness` |
| **Scenes auto-reference characters AND locations** named in them, shown per scene with approved / not-approved state | automatic; scene cards | `detectSceneReferences` |
| **Global scene settings + presets** — set aspect/quality/motion/model/style once for all scenes; save/load named studio-wide presets | Production → global-settings toolbar | `POST /:id/scene-defaults`, `/api/presets*` |
| **Canon version diff** — changelog between any version and the prior one (entities +/−, per-mark value/severity/status) | Story → Canon → "Changes since v…" | `GET /:id/canon/diff` |
| **Per-story Insights + studio dashboard** — volume, approvals, publishes, canon stability, drift health; cross-IP roll-up surfacing riskiest first | Story → Insights; Home → Studio overview | `GET /:id/analytics`, `GET /api/studio/analytics` |
| **Episode idea backlog** — brainstorm distinct future episodes (title/hook/synopsis), one-click Develop | Story → Episodes → "Suggest ideas" | `POST /:id/episode-ideas` |
| **Beat sheet** — structural hook→turn→climax→resolution, foldable into generation guidance | Episode → storyline step → "Beat sheet" | `POST /api/episodes/:id/beat-sheet` |
| **Dialogue & captions** + **Music & SFX** planning — sound-off captions, in-character lines, music direction, per-scene SFX + motifs (child-audience mode) | Production → "Dialogue & captions" / "Music & SFX" | `POST /:id/dialogue-plan`, `/:id/sound-plan` |
| **Shot manifest** download — reproducible per-scene production document (params, refs, prompt, edits, notes, clip status) | Production → "Shot manifest" | `GET /:id/manifest.md` |
| **YouTube localization + A/B titles** — translate title/description/tags/hashtags to any language; generate A/B title options with marketing angles | Production → YouTube editor | `POST /:id/youtube/localize`, `/:id/youtube/title-variants` |
| **Resilient long LLM calls** — abortable drift/generation with elapsed/cancel UX; no dev-proxy/server request timeouts (no more "failed to fetch") | storyline generation, drift check | — |

---

## 2. UX audit — what was wrong

1. **No hierarchy.** Every surface was a flat stack of equally-weighted cards on one
   endless scroll; a new user couldn't tell what the console *does* or where to start.
2. **Emoji as iconography** (~110 usages) — inconsistent rendering across platforms,
   unprofessional, and meaningless to screen readers.
3. **The production flow was implicit.** Compile → review → generate → validate → render
   → publish existed as scattered buttons with no ordering, and nothing *enforced*
   reviewing the compiled script before spending money.
4. **Raw markdown shown as `<pre>` text** — the compiled script and bible were unreadable
   walls of `#` and `-`.
5. **Critical information wasn't highlighted** — cost totals, blocking validation errors,
   and dry-run status had the same visual weight as helper text.
6. **Concrete CSS defects** — duplicate `.welcome` rule, form controls stretched to 100%
   width inside header rows, margin hacks on the topbar toggles, inconsistent spacing.
7. **Brand tied to one IP** ("PipBopShorts") although the engine is multi-IP by design.

## 3. The redesign

### Information architecture
- **Sidebar** = navigation: brand, Home, story library, and operations (Costs, Activity).
- **Story page** = tabs: **Episodes · Bible · Canon · References · Season · Settings** —
  the working surface (Episodes) is first; configuration is last.
- **Episode page** = a numbered pipeline: **1 Script → 2 Storyline → 3 Production**, with
  hard gates: generation is disabled until the compiled script is reviewed; "Render all"
  is disabled until validation passes.
- **Production page** = scenes → consistency → publish, with the validate-first gate.

### Design system
- **Dark theme only** — near-black page (`#0A0C10`), layered surfaces, hairline borders.
  Easy on the eye, maximizes attention on content and previews.
- **Bold typography** — heavy page titles (700–800), uppercase eyebrow labels for
  sections, tabular figures in tables, proportional bold figures for stat values.
- **One accent** (indigo `#5E6AD2` family) reserved for primary actions and active
  navigation. Status colors (green/amber/red) are reserved for state and always paired
  with a label — never color alone.
- **Critical information is promoted**: cost totals are stat tiles with a single hero
  figure; blocking errors are banners; money-spending actions are primary buttons with
  explicit confirmations stating what will be spent.
- **Inline SVG icon set** (`Icons.tsx`) replaces every emoji: 16px, stroke-based,
  `currentColor`, `aria-hidden`.
- **Rendered markdown** (`Markdown.tsx`: `marked` + `dompurify`) for compiled scripts,
  bible preview, and episode settings — with a raw-source toggle.

### Testing policy (no real APIs, ever)
- The entire suite runs against **fakes**: `makeFakePixverse` (in-memory HTTP fake),
  `makeFakeClaude` / `makeStudioFakeClaude` (canned structured outputs), dry-run YouTube.
- A **network guard** (`tests/setup.ts`) replaces `global.fetch` during tests and throws
  on any non-localhost request, so a real API call can never slip in silently.
- Anything ffmpeg-related uses the bundled binary and locally synthesized fixture videos.
