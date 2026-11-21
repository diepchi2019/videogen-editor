# VideoGen Editor

A CapCut-style video editor you can drive by chatting with Claude.

- **Edit by hand:** media bin, preview player, timeline with video / overlay / text / audio tracks, drag to reorder, drag edges to trim (with snapping), split, speed and speed ramps, reverse, freeze frame, volume, transitions, text overlays with animations, music with fades, multi-select, copy / paste, groups, ripple delete of a marked range, voiceover recording from the microphone, color looks and imported .cube LUTs, cover image export, undo/redo.
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

### Auto-captions: download a speech model

Captions run locally with Whisper, built into ffmpeg (the gyan.dev "full" Windows build and most Linux/Homebrew builds include it). Download one model file into `models/`:

| Model | Size | Use it when |
| --- | --- | --- |
| `ggml-large-v3-turbo-q5_0.bin` | 550 MB | Default choice. Close to the best accuracy, good for Vietnamese and other non-English speech. Fast with a GPU (about 6x real time on an NVIDIA T550), slower on CPU only (about real time). |
| `ggml-small.bin` | 470 MB | Older or CPU-only machines that find turbo too slow. |
| `ggml-base.bin` | 150 MB | Quick tests and clear English speech. Fastest, least accurate. |

```bash
curl -L -o models/ggml-large-v3-turbo-q5_0.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
```

When several models are present, the most accurate one is used (turbo, then small, then base). To force one, pick it in **⚙ Settings** (or set `VIDEOGEN_WHISPER_MODEL` to its path). Then click **CC Captions** in the timeline toolbar, or ask Claude to "add captions". Transcripts are cached per file, so restyling or redoing captions is instant. Long pauses are cut out before transcribing, so the first word after a pause gets the right time and no words are made up in quiet parts.

### Text to speech: install Piper and a voice

Voiceovers from a script run locally with [Piper](https://github.com/OHF-Voice/piper1-gpl) (free, private, a few seconds per paragraph on a laptop CPU). Install it with Python and download voices into `models/piper/`:

```bash
pip install piper-tts
python -m piper.download_voices en_US-lessac-medium vi_VN-vais1000-medium --download-dir models/piper
```

Other voices and languages: [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices). Then click **🗣 Voice** in the timeline toolbar, or ask Claude for a voiceover. The voice follows the language of the text; the take goes on a voice track, so music with ducking lowers under it and captions pick it up. To use a standalone piper executable instead of Python, enter its path in **⚙ Settings**.

**More expressive voices with ElevenLabs (optional, paid).** Paste your API key (elevenlabs.io → Developers → API keys) in **⚙ Settings**, then set *Engine* to ElevenLabs in the 🗣 Voice panel and pick a model (`eleven_v3` is the most expressive; the list marks the ones that speak Vietnamese) and a voice from your account. With `eleven_v3` you can steer the delivery with tags in the text, like `[excited]`, `[whispers]` or `[laughs]`. The *Expressive* slider works for both engines (calm ↔ lively). ElevenLabs bills per character; the same text, voice and settings are reused instead of being requested again. OpenAI is not offered: its speech endpoint models shut down on 6 January 2027.

### Remove pauses and filler words

Click **✂ Remove pauses** in the timeline toolbar (or ask Claude to "tighten the talking"). It reads where the words are from the Whisper transcript, finds the quiet stretches between them, and cuts every pause longer than 0.6s down to a short breath, plus "um", "uh", "ờ", "ừm" and silence at the start and end of each clip. It is one undo step; captions, texts and sound effects move with the cuts and background music keeps playing. Gaps with sound in them (music, a laugh, words Whisper did not write) are left alone. Claude can make it tighter or looser (`minPause`), list the cuts first (`dryRun`) or drop other words you name.

### Keyword highlights and auto zoom

After captions, click **★ Keywords** to highlight the key words (numbers, money, strong words) in their own color and a bit bigger, or ask Claude to pick them by meaning and add emoji ("highlight the payoff words and put 🔥 on the best one"). Emoji pop up above the caption line in color; they come from [Noto Emoji](https://github.com/googlefonts/noto-emoji) (Apache 2.0) and are downloaded once into `data/emoji/` the first time you use one.

Click **🔍 Auto zoom** to zoom like a talking-head edit: after **✂ Remove pauses**, every other jump cut is framed a little tighter (which hides the jump), and the picture punches in on the highlighted words (or on the loudest words when nothing is highlighted). Click it again to redo it; it is one undo step.

### Loudness

Every export is measured and brought to -14 LUFS (what TikTok, Reels, Shorts and YouTube play at), so your videos are never quieter or louder than the ones around them. Change the target (-16 for podcasts, -23 for broadcast, or off) in **⚙ Settings → Export**; Claude can also set it per export.

### Auto reframe: download the face model

Turning 16:9 footage into a 9:16 reel (and long videos into shorts) follows the speaker's face with a small local face detector ([YuNet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet), 230 KB, runs on the CPU). Download it once into `models/face/`:

```bash
curl -L -o models/face/face_detection_yunet_2023mar.onnx https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx
```

Then select a clip and click **⌖ Auto reframe**, or ask Claude to "reframe for vertical". `make_short` does it automatically. The crop follows the main face smoothly within a shot and jumps at shot changes; when two people are in the shot it stays on one until the other is clearly bigger for about a second. Clips without a face are left as they are (Claude can still frame them by looking at the frames).

## Settings

Everything you configure lives in one place: **⚙ Settings** in the top bar, saved to `data/settings.json` on this PC (git ignores `data/`).

| Setting | What it does |
| --- | --- |
| Anthropic API key, Claude model | The in-app chat panel. Not needed when you edit from Claude Code. |
| Text-to-speech engine, ElevenLabs API key, Piper executable | Voiceovers (pick the ElevenLabs model and voice in the 🗣 Voice panel). |
| Whisper model | Which speech model captions use (Auto = the most accurate one in `models/`). |
| Default text font | The font of texts and captions that do not choose one. |

API keys are checked when you save them and are write-only: the page only shows "set …abcd", and they are never sent to the browser or to Claude. Changes apply immediately. You can also edit the file by hand while the editor runs.

Environment variables still work and win over the file (the page shows when one does): `ANTHROPIC_API_KEY`, `CLAUDE_MODEL`, `ELEVENLABS_API_KEY`, `VIDEOGEN_PIPER`, `VIDEOGEN_WHISPER_MODEL`, `VIDEOGEN_FONT`. Only `PORT` and `VIDEOGEN_DATA` (the data folder, where the settings file lives) must be environment variables.

## Two ways to chat with Claude

### 1. In-app chat panel (Anthropic API key, pay per use)

Open **⚙ Settings** (top right), paste your Anthropic API key and pick the model (default `claude-sonnet-5-5`). It works right away, no restart.

### 2. From Claude Code via MCP (uses your Claude subscription, no API key)

Keep the editor running (`npm start`), then register the MCP server once:

```bash
claude mcp add videogen -- node /full/path/to/videogen-editor/mcp.js
```

Now in Claude Code: *"import ~/Videos/beach1.mp4 and beach2.mp4 into videogen, make a 15 second reel with fade transitions and a title"*. Edits appear live in the browser. Set `VIDEOGEN_URL` if the editor is not on `http://localhost:3000`.

## Tools Claude can use

`get_timeline`, `look_at_asset`, `add_clip`, `trim_clip`, `split_clip`, `delete_clip`, `move_clip`, `set_clip` (speed, reverse, volume, fit: contain/cover/blur, in/out animations), `set_color` (brightness, contrast, saturation, temperature, vignette, looks like vintage/cinematic/noir), `add_effect` / `delete_effect` (shake, zoom pulse, glitch, RGB split, flash, blur, VHS, light leak, invert), `set_keyframes` (animate scale/position/opacity/rotation/volume), `analyze_audio`, `mark_beats`, `fit_clips_to_beats` (cut to the beat), `add_markers` / `delete_markers`, `create_proxies`, `replace_clip_asset` (swap the file, keep the clip's settings), `auto_reframe` (the crop follows faces automatically when 16:9 footage goes into a 9:16 reel), `reframe_clip` (the same with points Claude reads from `look_at_asset` with `grid`, for subjects that are not faces), `remove_region` / `delete_region` (hide burned-in subtitles, watermarks, logos: `fill` or `patch` from a clean frame), `set_transition` (fade, dissolve, slides, wipes, circleopen, zoomin, pixelize…), `add_text` / `update_text` / `delete_text` (animations: fade, pop, slideup), `add_music` / `update_music` / `delete_music` (with `duck` to lower music under speech and `denoise` for hiss), `add_overlay` / `set_overlay` (picture-in-picture, logos, B-roll; `chromaKey` for green screen, `blend` modes like screen and multiply), `set_speed_ramp` (montage, hero, bullet… or your own curve), `freeze_frame`, `delete_range` (ripple delete), `remove_silences` (cut pauses and filler words), `emphasize_captions` (highlight key words, emoji), `auto_zoom` (jump-cut framing and punch-ins), `duplicate_items` / `delete_items` / `move_items` / `group_items` / `ungroup_items`, `list_luts` (and `set_color lut`), `set_canvas`, `undo` / `redo`, `export_video` (resolution, fps, bitrate, GPU encoding, loudness), `export_cover`, `export_status`, `list_styles` / `save_style` / `apply_style` / `delete_style` (reel styles), `list_templates` / `save_template` / `create_from_template` / `delete_template`, `find_moments` / `make_short` (long video to shorts), `add_voiceover` / `list_voices` (text to speech), plus `import_media` over MCP.

The MCP server also offers prompts (slash commands in Claude Code): `make_reel` (a reel from the media library in a style), `reel_from_template`, `save_my_style` and `reframe_to_vertical` (turn horizontal clips into a vertical reel that keeps the subject in frame) and `shorts_from_video` (cut a long video or podcast into several captioned shorts).

## Keyboard

Space play/pause · S split at playhead · F freeze frame · Delete remove selected · Ctrl/Shift+click select several · Ctrl/Cmd+C / V copy and paste at the playhead · Ctrl/Cmd+D duplicate · Ctrl/Cmd+G group (Shift: ungroup) · I / O mark a range, Shift+Delete removes it and closes the gap · Esc clear · Ctrl/Cmd+Z undo · Shift+Ctrl/Cmd+Z redo · ←/→ step a frame (Shift = 1s)

The Import button also takes `.cube` LUTs and `.ttf` / `.otf` fonts. 🎙 Record plays the timeline from the playhead (muted) while you speak and puts the take on a voice track.

## Layout

```
server.js        Express API, uploads, live updates (SSE)
mcp.js           MCP stdio server that forwards to the running editor
src/model.js     Project model + all edit operations (single source of truth)
src/presets.js   Saved reel styles and templates (data/styles, data/templates)
src/timing.js    Clip time <-> source time (speed ramps, reverse, freeze), shared with the browser
src/luts.js      Imported .cube LUTs (data/luts)
src/tools.js     Tool schemas shared by chat and MCP
src/chat.js      Claude tool-use loop for the in-app chat
src/render.js    Timeline -> ffmpeg filter graph -> MP4
src/media.js     ffprobe, thumbnails, frame extraction
public/          Browser UI (no build step)
test/smoke.js    End-to-end test: upload, edit, export, verify   (npm test)
test/mock-claude.js  Fake Claude API for testing the chat loop offline
```

## Known limits

- Auto-captions need a Whisper model file in `models/` (see *Auto-captions* above). Word times come from Whisper and can be off by a few tenths of a second; fix a line with `update_captions` if needed.
- The browser preview approximates the export (effects especially). It does not show LUTs, chroma key, removed regions, smooth slow motion or audio processing (noise reduction, voice effects, ducking); reversed clips play there by seeking, without sound. Use a draft export or `look_at_timeline` to see the real result.
- Text to speech needs Piper and a voice in `models/piper/` (see *Text to speech* above). There is no lipsync yet: a voiceover does not move anyone's mouth.
- Reverse works on up to 10s of source per clip (ffmpeg keeps the frames in memory).
