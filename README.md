# 🎬 PipBopShorts

A full-fledged platform for **creating, reviewing, and publishing AI short videos** with
[PixVerse](https://docs.platform.pixverse.ai/) and [Claude](https://www.anthropic.com/).

Manage multiple stories, ask Claude to write a shot-by-shot storyline (you pick the model
and effort), ship each scene to PixVerse, preview and tweak every clip, then publish the
finished short to YouTube Shorts.

---

## The workflow

0. **Start with an idea** — type one sentence on the welcome screen and the AI drafts the
   series title, production metadata (audience, genres, tones, format), a complete
   template-conformant bible with character visual signatures and "never change" lists,
   and (optionally) extracts canon v1 in the same flow. Episode briefs can likewise be
   drafted from an idea — always into the form for your review before saving.
1. **Story** — each story has a `.md` bible (built from a canonical **template** that
   captures premise, audience & tone, world rules, character visual signatures with
   "never change" lists, relationships, locations, story formula, and safety rails) plus
   **production metadata** (audience age range, genres, tones, format, episode length).
   Stories can use one **shared** setting, or give **each episode its own** setting.
   1. **Canon** — an LLM (default **Sonnet 5**; Opus 4.8 / Fable 5 selectable) dissects
      the bible into a **version-controlled canon registry**: characters, relationships,
      locations, props, world rules, visual style, and auto-generated audience/tone
      marks — each a consistency mark with severity `locked`/`strong`/`flexible` and a
      stable asset id (`CHAR_BOBO_001` style).
   2. **Drift control** — storylines are generated against the canon and can be
      **checked for drift**; each finding can be **rejected**, **accepted now** (new
      canon version), or **accepted gradually** (the mark transitions and future
      storylines blend toward the new value).
2. **Episode** — a short brief for what happens. In per-episode mode it carries its own
   setting `.md` that overrides the bible. Each episode has a selectable target runtime
   (**15s, 30s, 1 min, 1 min 30s, 3 min, 5 min**) and can be **auto-generated**:
   - **Random stories** (default): the AI invents the next standalone episode, reusing the
     canon and avoiding repeats — the series can run forever.
   - **Linear stories**: plan a **season arc** for N episodes first (extendable — the old
     finale becomes a mid-season beat); episodes are then generated in order, each briefed
     with a recap of previous episodes, its slot's arc note, and a no-spoiler finale
     guard. All of that continuity context also flows into storyline generation.
3. **Storyline** — Claude reads the bible + brief and returns a structured, shot-by-shot
   storyline. **You pick the model and effort**:
   - Models: `claude-fable-5`, `claude-opus-4-8`, `claude-sonnet-5`, `claude-haiku-4-5`
   - Effort: `low` → `max` (ignored for models that don't support it)
   - Each scene is a self-contained PixVerse prompt with its own duration, aspect ratio,
     model, quality, motion mode, style, and camera movement.
4. **Render** — ship scenes to PixVerse (text-to-video, or image-to-video with a reference
   image), poll to completion, and preview each clip inline.
5. **Tweak / review** — edit any scene's prompt or parameters and re-render, refresh a
   still-rendering clip, **extend** a clip, add/remove/reorder scenes, and attach reference
   images. Everything PixVerse exposes is a control in the UI.
6. **Publish** — edit the YouTube title/description/tags/hashtags and publish to YouTube
   Shorts (with an optional ffmpeg stitch of all clips). Runs in **dry-run** mode until
   YouTube credentials are configured.

---

## Quick start

```bash
# 1. Install
npm install
npm run web:install       # frontend deps

# 2. Configure
cp .env.example .env
#   set PIXVERSE_API_KEY; make sure the Claude Code Gateway is running (YouTube creds are optional)

# 3. Build the UI and run the server
npm run web:build
npm start                 # http://localhost:4000

# --- OR, for development with hot reload ---
npm run dev               # backend on :4000
npm run web:dev           # frontend on :5173 (proxies /api to :4000)
```

Open <http://localhost:4000> (production) or <http://localhost:5173> (dev).

### Environment variables

| Variable | Purpose |
| --- | --- |
| `PIXVERSE_API_KEY` | PixVerse platform API key (required to render) |
| `PIXVERSE_BASE_URL` | Override the PixVerse base URL (defaults to the openapi/v2 endpoint) |
| `CLAUDE_GATEWAY_URL` | Local Claude Code Gateway URL used to generate storylines (default `http://localhost:8757`). The gateway wraps the `claude` CLI and supplies its own auth — no Anthropic API key needed. |
| `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` / `YOUTUBE_REFRESH_TOKEN` | OAuth2 for the YouTube Data API v3. Leave blank for dry-run. |
| `YOUTUBE_DRY_RUN` | Force dry-run even when credentials are present |
| `PORT` | Server port (default `4000`) |
| `DATA_DIR` | Where stories, storylines, and job state are persisted (default `./data`) |

---

## Testing

The service and API layers are fully covered by a regression suite with all external
services (PixVerse, Claude, YouTube) mocked — no network or API keys needed.

```bash
npm test          # vitest run  (65 tests)
npm run typecheck # tsc --noEmit
```

Tests live in `tests/`:

| File | Covers |
| --- | --- |
| `pixverse.test.ts` | request shaping, headers, envelope errors, polling, parameter validation |
| `claude.test.ts` | per-model request construction (thinking/effort/fallbacks), parsing, refusals |
| `store.test.ts` | file-backed store, `.md` bibles/settings, persistence, cascading deletes |
| `services.test.ts` | storyline creation, scene tweaking, render/refresh/extend, publish |
| `canon.test.ts` | templates, canon extraction/versioning, auto audience marks, transitions, canon-aware generation |
| `exchange.test.ts` | `.story.md` export/import round-trip, marker escaping, format-version guard |
| `drift.test.ts` | drift detection, mapping to canon/scenes, accept-now / accept-gradually / reject |
| `api.test.ts` | the full workflow end-to-end over HTTP (supertest), including canon + drift |

---

## Architecture

```
src/
  clients/
    pixverse.ts     PixVerse API client + parameter validation + polling
    claude.ts       Storyline generation (structured outputs, model/effort picker)
    youtube.ts      YouTube resumable upload + dry-run
  services/
    storyline.ts    Create storyline projects; edit scenes & youtube metadata
    generation.ts   Render / refresh / extend clips; upload reference images
    publish.ts      Choose the video and publish it
    stitch.ts       Optional ffmpeg concat of clips
  store/store.ts    File-backed persistence (db.json + .md files on disk)
  app.ts            Express app factory (dependencies injected for testing)
  index.ts          Wires real clients and starts the server
web/                React + Vite single-page UI
```

Data on disk:

```
data/
  db.json                              structured records (stories, episodes, projects)
  stories/<storyId>/bible.md           the story bible
  stories/<storyId>/episodes/<epId>/setting.md   per-episode setting override
```

---

## PixVerse integration

Built against the PixVerse OpenAPI v2 endpoints:

| Action | Endpoint |
| --- | --- |
| Upload image | `POST /openapi/v2/image/upload` |
| Text-to-video | `POST /openapi/v2/video/text/generate` |
| Image-to-video | `POST /openapi/v2/video/img/generate` |
| Extend video | `POST /openapi/v2/video/extend/generate` |
| Status / result | `GET /openapi/v2/video/result/{video_id}` |

Requests send the `API-KEY` and a per-request `Ai-trace-id` header. Status codes are mapped
(`1` success, `5` generating, `6` deleted, `7` moderation failed, `8` failed). Allowed
values (models `v3.5`–`v5.5`, quality `360p`–`1080p`, durations `5`/`8`, aspect ratios,
motion modes, styles, camera movements) are validated before any call is made, including
constraints like "1080p is 5s only".

## Claude integration

Storylines are generated with the Anthropic Messages API using **structured outputs**, so
the response is always a valid storyline object. Requests are shaped per model:

- **Fable 5** — thinking is always on (no `thinking` param), `effort` via `output_config`,
  and the server-side refusal `fallbacks` to Opus 4.8 are enabled.
- **Opus 4.8 / Sonnet 5** — adaptive thinking + `effort`.
- **Haiku 4.5** — structured outputs only (no effort/thinking).

## YouTube publishing

Uses the YouTube Data API v3 resumable upload with an OAuth2 refresh token. `#Shorts` is
ensured in the title/description. Without credentials the platform runs in **dry-run** mode
so you can exercise the whole flow safely.

---

## API reference (selected)

| Method & path | Description |
| --- | --- |
| `GET /api/config` | Available models, efforts, and PixVerse options |
| `POST /api/stories` | Create a story |
| `PUT /api/stories/:id/bible` | Save the story bible (`.md`) |
| `POST /api/stories/:id/episodes` | Add an episode |
| `POST /api/episodes/:id/storylines` | Generate a storyline with Claude |
| `PATCH /api/storylines/:id/scenes/:sceneId` | Tweak a scene (resets its clip) |
| `POST /api/storylines/:id/scenes/:sceneId/generate` | Render a scene |
| `POST /api/storylines/:id/scenes/:sceneId/refresh` | Poll a rendering scene |
| `POST /api/storylines/:id/scenes/:sceneId/extend` | Extend a rendered clip |
| `POST /api/storylines/:id/scenes/:sceneId/image` | Attach a reference image (base64) |
| `POST /api/storylines/:id/generate` | Render all scenes |
| `POST /api/storylines/:id/publish` | Publish to YouTube Shorts |
| `POST /api/stories/bootstrap` | Idea → LLM-populated story (title, metadata, full bible, optional canon) |
| `POST /api/stories/:id/plan` | Plan a linear season arc for N episodes |
| `POST /api/stories/:id/plan/extend` | Extend the season (old finale becomes a mid-season beat) |
| `POST /api/stories/:id/episodes/generate` | Auto-generate the next episode (random: fresh standalone; linear: next plan slot with recap) |
| `GET /api/stories/:id/bible.md` · `GET /api/episodes/:id/setting.md` · `GET /api/templates/*.md` | Raw `.md` downloads |
| `POST /api/stories/:id/episodes/draft` | Idea → drafted episode title/brief/setting (not persisted; review in the form) |
| `GET /api/stories/:id/export` | Download the story as a portable `.story.md` package (bible, episodes + settings, canon history, storylines) |
| `POST /api/stories/import` | Import a `.story.md` package as a new story (fresh ids; clips/publish state excluded by design) |
| `GET /api/templates/story-bible` | Canonical story-bible `.md` template |
| `GET /api/stories/:id/canon` | Canon registry (all versions) |
| `POST /api/stories/:id/canon/extract` | Dissect the bible into a new canon version |
| `PATCH /api/stories/:id/canon/entities/:eid/marks/:key` | Edit a mark / start or complete a transition |
| `POST /api/storylines/:id/drift-check` | Check the storyline against canon |
| `POST /api/storylines/:id/drift/:rep/findings/:f/resolve` | Resolve drift (accept-now / accept-gradually / reject) |

See **docs/ROADMAP.md** for the phased plan toward the full AI film production studio
(reference image library, scene patch requests, shot manifests, approval workflow,
long-form episodes).
