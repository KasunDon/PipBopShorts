# PipBopShorts — AI Film Production Studio Roadmap

This roadmap folds the *AI Film Studio Agent Handover Spec* and the *PipBop Story & Series
Bible* into the platform, broken into deliverable phases. The guiding principle from the
spec applies everywhere:

> **Treat every approved output as an existing film set.** When the director requests one
> small change, change only that property and preserve everything else.

The platform is a **studio**: multiple IPs (stories), each with version-controlled canon,
repeatable AI workflows, and human approval at every creative gate. First IP: kids'
content — so emotional safety and consistency are product features, not afterthoughts.

---

## ✅ Phase 0 — Core pipeline (shipped)

Story → episode → Claude storyline (model + effort picker) → PixVerse render →
preview/tweak/extend → YouTube Shorts publish (dry-run capable). Regression suite with all
externals mocked.

## ✅ Phase 1 — Canon & consistency foundation (shipped)

The "continuity supervisor" layer:

- **Canonical `.md` templates** (story bible, episode setting) — generic structure that
  captures premise, audience & tone, world rules, character *visual signatures* with
  explicit **"never change"** lists, relationships, locations, story formula, safety
  rails, and ready-to-paste consistency prompts.
- **Story production metadata** — audience age range, genres, tones, format, episode
  length — steering every storyline and auto-generating audience/tone consistency marks.
- **Canon extraction** — an LLM (default **Sonnet 5**, selectable Opus 4.8 / Fable 5)
  dissects the bible into a **version-controlled canon registry**: characters,
  relationships, locations, props, world rules, visual style, audience/tone. Every fact is
  a *consistency mark* with severity `locked` / `strong` / `flexible` and stable asset IDs
  (`CHAR_BOBO_001`-style).
- **Drift detection** — any storyline can be checked against canon; findings carry
  severity, the exact scenes involved, and a suggestion.
- **Drift resolution** — per finding: **reject** (canon stands), **accept now** (new canon
  version), or **accept gradually** (the mark enters a `transitioning` state; future
  storylines are instructed to blend from the old value toward the new one until the
  transition is completed).
- Canon block + global negative prompt injected into all storyline generation; child-
  safety directives activate automatically when the audience is ≤ 12.

## ✅ Phase 2a — Character reference images (shipped)

Consistency by reference, not just by prompt:

- Versioned **character reference registry** synced from canon characters.
- Generate a PixVerse **portrait** per character from a canon-built prompt; **refresh**
  and **tweak-prompt** on demand — every attempt is an immutable version, with an
  **approved** pointer.
- Approved reference is **sent to PixVerse** at scene render time (image-to-video via an
  uploaded `img_id`; first-frame auto-extraction when ffmpeg is present, plus direct
  still upload), with approved descriptors injected into the prompt.
- Scenes **auto-link** to the characters named in them; the whole registry is
  version-controlled and rides along in `.story.md` export/import.

## 🔜 Phase 2b — Location/prop references & scene patching (next)

- **Reference library for locations & props** (same pattern as characters): approved
  stills attached to canon entities and injected into the relevant scenes.
- Multi-reference scenes: send more than one approved image when the model supports it.
- **Scene patch requests** ("make Bobo look worried, change nothing else"): a directed
  regeneration flow that builds a *patch prompt* — change-one-property + preserve-exactly
  + reject-if list — instead of free regeneration. Patch history per scene.
- **Approval workflow**: clip status gains `draft → candidate → approved → canonical`;
  publishing requires approved clips; approved clips become references for future scenes.
- **Continuity QC checklist** auto-run on rendered clips (LLM vision pass against canon
  marks: accessory present? colors right? style consistent?).
- **Canon diff view** in the UI (side-by-side mark changes between versions, changelog).

## Phase 3 — Episode production depth

- **Beat sheets & shot manifests**: storyline → beat sheet → per-scene manifest (camera
  preset, lighting preset, locked properties, allowed variation) as the unit the renderer
  consumes; seeds and generation params recorded per attempt for reproducibility.
- **Dialogue & sound planning**: dialogue lines per scene (kid-appropriate line-length
  rules), sound-effect and music cue notes, character sound motifs from the bible.
- **Assembly**: server-side stitch with transitions, title/end cards, safe-area checks for
  Shorts; per-scene retry queue with cost tracking.
- **Series planning**: episode idea backlog generated from canon ("future episode ideas"),
  one-click "develop idea → episode brief".

## Phase 4 — Studio scale

- **Multi-IP dashboards**: per-story analytics (episodes produced, drift rate, canon
  stability), cross-IP shared style presets.
- **Longer formats**: 3-act structure support (primary thread + friendship thread + comedy
  runner), scene-count scaling, per-act drift checks.
- **Season arcs**: season-level canon (what may evolve across a season vs. never),
  scheduled production runs.
- **Team workflow**: review/approve roles, comments on scenes, audit log of canon changes.

## Phase 5 — Distribution intelligence

- Publish scheduling, A/B titles/thumbnails, retention analytics fed back into the story
  formula, localization (dubbed/translated variants with canon-consistent visuals).

---

## Design tenets (all phases)

1. **AI is crew, not director** — every canon change, drift acceptance, and publish is a
   human decision surfaced in the UI.
2. **Version everything that defines the IP** — canon versions are append-only history;
   nothing is silently rewritten.
3. **Locked by default** — unlisted properties are preserved; only explicitly requested
   changes are allowed (drives the Phase 2 patch flow).
4. **Kid-safe by construction** — audience metadata activates hard safety rails in
   prompts, negative prompts, and QC; safety marks are always `locked`.
5. **Generic engine, specific IPs** — templates and canon schema stay IP-agnostic; PipBop
   is the first tenant, not a special case.
