# VideoGen Editor

A CapCut-style video editor you can drive by chatting with Claude.

- **Edit by hand:** media bin, preview player, timeline with video / text / music tracks, drag to reorder, drag edges to trim, split, speed, volume, transitions, text overlays with animations, music with fades, undo/redo.
- **Edit by chat:** type "cut the first 2 seconds, add a fade between every clip, put the title 'Juju đi biển' at the top". Claude edits the timeline with tools and can **look at frames** of your clips to find moments ("make the part where he jumps slow motion").
- **Your reel style and templates:** save a look (fonts, colors, caption style, transitions, color grade, music mix, intro, outro, logo) as a style and apply it to any project in one step. Or save a finished edit as a template and fill its slots with new clips. Three built-in styles are included (Bold reel, Clean minimal, Warm vlog). Use the *Styles & templates* menu in the header, or ask Claude ("make this in my style", "make a new reel from my travel template").
- **Export:** real MP4 rendered with ffmpeg (9:16, 16:9, 1:1, 4:5), with transitions (xfade), text, blurred-background fill for horizontal clips, and mixed music.

## Run it

Needs Node 20+ and ffmpeg on your PATH (`brew install ffmpeg`, `winget install ffmpeg`, or `apt install ffmpeg`).

```bash
npm install
npm start                    # http://localhost:3000
```

Your project, media and exports are stored in `./data/`.

## Two ways to chat with Claude

### 1. In-app chat panel (Anthropic API key, pay per use)

```bash
ANTHROPIC_API_KEY=sk-ant-... npm start
# optional: CLAUDE_MODEL=claude-opus-5-5 (default claude-sonnet-5-5)
```

### 2. From Claude Code via MCP (uses your Claude subscription, no API key)

Keep the editor running (`npm start`), then register the MCP server once:

```bash
claude mcp add videogen -- node /full/path/to/videogen-editor/mcp.js
```

Now in Claude Code: *"import ~/Videos/beach1.mp4 and beach2.mp4 into videogen, make a 15 second reel with fade transitions and a title"*. Edits appear live in the browser. Set `VIDEOGEN_URL` if the editor is not on `http://localhost:3000`.

## Tools Claude can use

`get_timeline`, `look_at_asset`, `add_clip`, `trim_clip`, `split_clip`, `delete_clip`, `move_clip`, `set_clip` (speed, volume, fit: contain/cover/blur, in/out animations), `set_color` (brightness, contrast, saturation, temperature, vignette, looks like vintage/cinematic/noir), `add_effect` / `delete_effect` (shake, zoom pulse, glitch, RGB split, flash, blur, VHS, light leak, invert), `set_keyframes` (animate scale/position/opacity/rotation/volume), `analyze_audio`, `mark_beats`, `fit_clips_to_beats` (cut to the beat), `add_markers` / `delete_markers`, `create_proxies`, `replace_clip_asset` (swap the file, keep the clip's settings), `remove_region` / `delete_region` (hide burned-in subtitles, watermarks, logos: `fill` or `patch` from a clean frame), `set_transition` (fade, dissolve, slides, wipes, circleopen, zoomin, pixelize…), `add_text` / `update_text` / `delete_text` (animations: fade, pop, slideup), `add_music` / `update_music` / `delete_music` (with `duck` to lower music under speech), `set_canvas`, `undo` / `redo`, `export_video` (resolution, fps, bitrate, GPU encoding), `export_status`, `list_styles` / `save_style` / `apply_style` / `delete_style` (reel styles), `list_templates` / `save_template` / `create_from_template` / `delete_template`, plus `import_media` over MCP.

The MCP server also offers prompts (slash commands in Claude Code): `make_reel` (a reel from the media library in a style), `reel_from_template` and `save_my_style`.

## Keyboard

Space play/pause · S split at playhead · Delete remove selected · Ctrl/Cmd+Z undo · Shift+Ctrl/Cmd+Z redo · ←/→ step a frame (Shift = 1s)

## Layout

```
server.js        Express API, uploads, live updates (SSE)
mcp.js           MCP stdio server that forwards to the running editor
src/model.js     Project model + all edit operations (single source of truth)
src/presets.js   Saved reel styles and templates (data/styles, data/templates)
src/tools.js     Tool schemas shared by chat and MCP
src/chat.js      Claude tool-use loop for the in-app chat
src/render.js    Timeline -> ffmpeg filter graph -> MP4
src/media.js     ffprobe, thumbnails, frame extraction
public/          Browser UI (no build step)
test/smoke.js    End-to-end test: upload, edit, export, verify   (npm test)
test/mock-claude.js  Fake Claude API for testing the chat loop offline
```

## Known limits (MVP)

- One project at a time; single main video track (no picture-in-picture yet).
- The browser preview shows every transition as a crossfade; the export renders the real transition.
- No auto-captions from speech yet (next step: Whisper transcription → `add_text` per phrase).
