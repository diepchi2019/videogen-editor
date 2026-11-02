# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A chat-driven, CapCut-style short-video editor: a browser timeline UI, Claude tool-use editing (in-app chat or via MCP from Claude Code), and real MP4 export through ffmpeg. Plain Node ESM (`"type": "module"`), no build step, no TypeScript, no linter configured. Requires Node 20+ and `ffmpeg`/`ffprobe` on PATH.

## Commands

```bash
npm install
npm start                 # editor at http://localhost:3000 (PORT to override)
npm run mcp               # MCP stdio server; forwards to a running editor (VIDEOGEN_URL, default http://localhost:3000)
npm test                  # end-to-end smoke test (test/smoke.js)
```

- There is a single test, `test/smoke.js`: it spawns `server.js` on port 3999 with `VIDEOGEN_DATA` set to a temp dir, uploads `test/fixtures/*`, drives edits through `POST /api/tool/:name`, exports a draft, and checks the output with `ffprobe`. It needs real ffmpeg. It writes `test/last-frame.png` (gitignored).
- `test/mock-claude.js` is a fake Anthropic Messages API (port `MOCK_PORT`, default 3200) for exercising the chat loop without a key. Start it, then run the server with `ANTHROPIC_API_KEY=x ANTHROPIC_BASE_URL=http://localhost:3200` and post to `/api/chat`.

Environment variables: `ANTHROPIC_API_KEY` (enables the in-app chat), `CLAUDE_MODEL` (default `claude-sonnet-5-5`), `VIDEOGEN_DATA` (data dir, default `./data`), `VIDEOGEN_FONT` (drawtext font; otherwise the first existing of DejaVu, Arial Bold, or `C:/Windows/Fonts/arialbd.ttf`), `PORT`, `VIDEOGEN_URL` (MCP only).

## Architecture

**One edit pipeline, three callers.** Every timeline mutation is a pure function in `ops` in `src/model.js`, with signature `(draftProject, input) => message string`. It throws `OpError` on invalid input, and the error text goes back to Claude, so make it actionable. Edits from the browser UI, the in-app chat, and MCP all go through the same path:

```
UI (public/app.js) ─┐
chat (src/chat.js) ─┼─> executeTool (src/tools.js) ─> store.apply (src/store.js) ─> ops[name] (src/model.js)
MCP (mcp.js) ─HTTP─>┘   via POST /api/tool/:name
```

- `src/store.js` keeps the single project in memory. `apply()` runs the op on a `structuredClone` draft, pushes the previous project onto the undo stack (max 100), writes `data/project.json` synchronously, and emits change events. Undo and redo swap whole project snapshots.
- `server.js` sends every store change to the browser over SSE (`GET /api/events`, events `project`, `jobs` and `chat-action`). That is how edits made by Claude show up live in the UI. The `x-source` header (`ui`/`mcp`/`claude`) labels where a change came from.
- `src/tools.js` defines `TOOLS` once, in Anthropic `input_schema` format. The chat sends them to the API as they are, and `mcp.js` fetches them from `GET /api/tools` and maps them to MCP `inputSchema`. **To add an editing tool:** add the op to `ops` in `model.js` and its schema to `TOOLS`. The `default:` branch of `executeTool` routes it to `store.apply`. Tools that aren't ops (`get_timeline`, `look_at_asset`, `undo`/`redo`, `export_*`) are special-cased in the `switch`. `import_media` exists only in `mcp.js` (it reads local paths and uploads them).
- `look_at_asset` returns Anthropic image content blocks (base64 JPEG from `src/media.js` `extractFrames`). `mcp.js` turns them into MCP image blocks.

**Timeline model.** There is one ordered main video track, `project.clips`. Clips have no stored start time. `layout(p)` works out the positions, and a transition on clip *i* overlaps it with clip *i-1* by the transition's duration, so adding transitions makes the video shorter. Clip `in`/`out` are seconds in the source file. Text and music `start`/`end` are seconds on the timeline. Clip duration = `(out - in) / speed`. `summarize(p)` produces the text view Claude sees (in `get_timeline` and in the chat system prompt), so keep it in sync when you add fields.

**Rendering.** `src/render.js` `buildCommand` turns the project into one ffmpeg invocation. Each clip becomes an input, normalised to WxH@fps with stereo 48k audio of exact length (silence is generated for clips without audio or images; fit modes are contain, cover and blur). The clips are chained with `xfade`/`acrossfade` using the overlaps from `layout`. Texts become `drawtext` (escape values with the `q()` helper) and music is mixed with `amix`. Jobs run asynchronously in an in-memory map and are polled through `/api/jobs/:id` / `export_status`. A `draft` export renders at half resolution. The browser preview shows every transition as a crossfade, and only the export renders the real transition type.

**Chat.** `src/chat.js` runs a manual tool-use loop (at most 15 steps) with history kept on the server (trimmed to about 30 messages, cut only at a plain user text turn). The current project summary is injected into the system prompt on every request.

**Frontend.** `public/` is vanilla JS/CSS served statically, with no framework and no bundler.

## Data

Everything lives in `data/` (gitignored): `project.json`, `media/` (uploads renamed to `f_<hex>.<ext>`), `thumbs/`, `exports/`, and temporary `tmp-*` render dirs. There is only one project at a time.
