# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A chat-driven, CapCut-style short-video editor: a browser timeline UI, Claude tool-use editing (in-app chat or via MCP from Claude Code), and real MP4 export through ffmpeg. Plain Node ESM (`"type": "module"`), no build step, no TypeScript, no linter configured. Requires Node 20+ and `ffmpeg`/`ffprobe` on PATH.

## Commands

```bash
npm install
npm start                 # editor at http://localhost:3000 (PORT to override)
npm run mcp               # MCP stdio server; forwards to a running editor (VIDEOGEN_URL, default http://localhost:3000)
npm test                  # unit tests (test/unit.test.js) then the end-to-end smoke test (test/smoke.js)
npm run test:unit         # unit tests only: pure model/ASS/graph checks, no ffmpeg needed (except one graph test that reads fonts)
```

- `test/unit.test.js` (node:test) covers ops, validation, transcript-to-timeline mapping, caption grouping, ASS output, batch/projects in the store, and the shape of the ffmpeg graph. It sets `VIDEOGEN_DATA` to a temp dir before importing the store.
- `test/smoke.js` spawns `server.js` on port 3999 with `VIDEOGEN_DATA` set to a temp dir, uploads `test/fixtures/*`, drives edits through `POST /api/tool/:name`, transcribes `speech.mp3` (skipped if there is no whisper model), exports with `wait`, checks the output with `ffprobe`, switches projects, and drives `mcp.js` with a real MCP client. It needs real ffmpeg. It writes `test/last-frame.png` and `test/last-timeline/*.jpg` (gitignored) — look at them after visual changes.
- `test/mock-claude.js` is a fake Anthropic Messages API (port `MOCK_PORT`, default 3200) for exercising the chat loop without a key. Start it, then run the server with `ANTHROPIC_API_KEY=x ANTHROPIC_BASE_URL=http://localhost:3200` and post to `/api/chat`.

Environment variables: `ANTHROPIC_API_KEY` (enables the in-app chat), `CLAUDE_MODEL` (default `claude-sonnet-5-5`), `VIDEOGEN_DATA` (data dir, default `./data`), `VIDEOGEN_FONT` (path of the default text font file; otherwise the first installed of Arial, DejaVu Sans, Helvetica, Liberation Sans, Noto Sans), `VIDEOGEN_WHISPER_MODEL` (whisper.cpp ggml model; default `models/ggml-base.bin`, gitignored, download from huggingface.co/ggerganov/whisper.cpp), `PORT`, `VIDEOGEN_URL` (MCP only).

ffmpeg must be built with libass and (for captions) whisper. ffmpeg 7+ reads the filter graph with `-/filter_complex <file>`; `render.js` detects the version and falls back to `-filter_complex_script` on older builds.

## Architecture

**One edit pipeline, three callers.** Every timeline mutation is a pure function in `ops` in `src/model.js`, with signature `(draftProject, input) => message string`. It throws `OpError` on invalid input, and the error text goes back to Claude, so make it actionable. Edits from the browser UI, the in-app chat, and MCP all go through the same path:

```
UI (public/app.js) ─┐
chat (src/chat.js) ─┼─> executeTool (src/tools.js) ─> store.apply (src/store.js) ─> ops[name] (src/model.js)
MCP (mcp.js) ─HTTP─>┘   via POST /api/tool/:name
```

- `src/store.js` keeps the open project in memory. `apply()` runs the op on a `structuredClone` draft, pushes the previous project onto that project's undo stack (max 100, kept per project id), writes `data/projects/<id>/project.json` synchronously (tmp + rename), and emits change events. Undo and redo swap whole project snapshots. `applyBatch()` (tool `batch_edit`) runs many ops on one draft as one undo step; a string `"$N"` in a later step's input is replaced by the id created by step N. Projects: `listProjects/createProject/openProject/duplicateProject/deleteProject` (delete moves the folder to `data/trash`). `migrate()` in model.js upgrades any loaded project; a legacy `data/project.json` is moved into `data/projects/` on first start.
- `server.js` sends every store change to the browser over SSE (`GET /api/events`, events `project`, `jobs` and `chat-action`). That is how edits made by Claude show up live in the UI. The `x-source` header (`ui`/`mcp`/`claude`) labels where a change came from.
- `src/tools.js` defines `TOOLS` once, in Anthropic `input_schema` format. The chat sends them to the API as they are, and `mcp.js` fetches them from `GET /api/tools` and maps them to MCP `inputSchema`. **To add an editing tool:** add the op to `ops` in `model.js` and its schema to `TOOLS`. The `default:` branch of `executeTool` routes it to `store.apply`. Tools that aren't ops (`get_timeline`, `look_at_*`, `batch_edit`, project tools, `list_fonts`, `transcribe_asset`/`get_transcript`/`add_captions`, `undo`/`redo`, `export_*`) are special-cased in the `switch`; async work (whisper, rendering) lives there, never in ops. `set_captions` is an op without a schema: `add_captions` transcribes, maps words with `timelineWords()`, then applies it. `toolAnnotations()` adds MCP hints (`/api/tools` includes them; the chat sends plain `TOOLS` because the Anthropic API rejects unknown fields). `import_media` exists only in `mcp.js` (it reads local paths and uploads them; `.ttf/.otf` uploads go to `data/fonts`). `mcp.js` also serves resources `videogen://project/timeline` and `videogen://project/json`.
- `look_at_asset` (source frames, `src/media.js` `extractFrames`) and `look_at_timeline` (composited output frames, `render.js` `renderFrames`, which runs `buildCommand` in frames mode with a `select` filter) return Anthropic image content blocks. `mcp.js` turns them into MCP image blocks.

**Timeline model.** There is one ordered main video track, `project.clips`. Clips have no stored start time. `layout(p)` works out the positions, and a transition on clip *i* overlaps it with clip *i-1* by the transition's duration, so adding transitions makes the video shorter. Clip `in`/`out` are seconds in the source file. Text, overlay and audio `start`/`end` are seconds on the timeline. Clip duration = `(out - in) / speed`. Other layers:
- `overlays[]`: video/image placed at an absolute `start` on top of the main track (not magnetic), with `track` (z-order), `fit` (free = `x`,`y` center + `scale` as width fraction; cover; contain), `opacity`, `rotate`, `crop`, flips, `volume`, `animation`.
- Clip `transform` (`crop` fractions, `rotate`, `flipH/V`, `scale`, `x`, `y`; omitted keys = identity) and `motion` (`{preset, intensity}` Ken Burns).
- `texts[]` carry style fields (`font`, `bold`, `outline`, `shadow`, `blur`, `box`, `animation`, `animationOut`, `style` preset name). A text without `outline` keeps the old automatic outline.
- `captions`: `{style, lines:[{id,start,end,words:[{w,start,end}]}]}` in timeline seconds. Transcripts are cached per media file in `data/analysis/<file>.words.json` (source seconds) and mapped through clip in/out/speed by `timelineWords()`.
- `music[]` is every audio item: `role` music/sfx/voice and `track` (the tool names stay `add_music`/`update_music`/`delete_music`).
Colors are validated to hex by `color()` because they go into filter graphs and ASS files. `summarize(p)` produces the text view Claude sees (in `get_timeline` and in the chat system prompt), so keep it in sync when you add fields.

**Rendering.** `src/render.js` `buildCommand` turns the project into one ffmpeg invocation. Each clip becomes an input, normalised to WxH@fps with stereo 48k audio of exact length (silence is generated for clips without audio or images; fit modes are contain, cover and blur). The clips are chained with `xfade`/`acrossfade` using the overlaps from `layout`. Clip transforms, then fit, then scale/position (overlay on a color canvas), then Ken Burns (`zoompan` on a 2x frame). Overlays are chained with `overlay` (`setpts=PTS+start/TB`, `enable=between`), and their audio joins the mix. All texts and captions are one ASS file built by `src/ass.js` (PlayRes = canvas size, so sizes are canvas px) and drawn with the `ass` filter; `src/fonts.js` reads family names from font files and copies the needed families into the render's `fontsdir`. Escape filter option values with the `q()` helper. Audio items are mixed with `amix`. Jobs (`src/jobs.js`) run asynchronously in an in-memory map and are polled through `/api/jobs/:id` / `export_status`, or awaited with `export_video {wait:true}`. A `draft` export renders at half resolution. The browser preview shows every transition as a crossfade, and only the export renders the real transition type. The preview also does not show clip transforms, Ken Burns, overlay crop, or the new text styles/out-animations; use `look_at_timeline` or a draft export to see them.

**Chat.** `src/chat.js` runs a manual tool-use loop (at most 15 steps) with history kept on the server (trimmed to about 30 messages, cut only at a plain user text turn). The current project summary is injected into the system prompt on every request.

**Frontend.** `public/` is vanilla JS/CSS served statically, with no framework and no bundler.

## Data

Everything lives in `data/` (gitignored): `projects/<id>/project.json`, `state.json` (open project id), `media/` (uploads renamed to `f_<hex>.<ext>`, shared by all projects; each project has its own `assets` map), `thumbs/`, `exports/`, `analysis/` (transcripts), `fonts/` (imported fonts), `trash/` (deleted projects), and temporary `tmp-*` render dirs.
