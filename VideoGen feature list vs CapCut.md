# VideoGen feature list vs CapCut

Nov 2, 2026 · @Ngoc · updated Nov 22, 2026

VideoGen now covers everything a short-form editor needs for reels and talking-head videos, including most of CapCut's AI helpers (captions, auto reframe, silence and retake removal, long video to shorts, text to speech). What is left against CapCut is mostly breadth (hundreds of effects, a template and text-design library, color curves), a few vision features (background removal, motion tracking, retouch), AI generation (script to video, avatars) and direct publishing. Every feature is also an MCP tool, so Claude can do it too.

CapCut features below come from its desktop and mobile apps as I know them (approximate, not checked against today's release notes).

- **Status:** Have = works in the MVP now. Partial = basic version exists. Missing = not built.
- **Priority:** P0 = needed to make reels like the islandboyjuju ones. P1 = makes it a real CapCut alternative. P2 = nice to have.

## Editor features vs CapCut

Of the 80 CapCut features listed, VideoGen has 68, 4 more in part and 8 missing (updated Nov 22, 2026, after the no-AI set: 14 more effects, color curves / HSL / wheels, masks on main clips, title templates, emoji stickers, motion tracking, sharpen / clean). Every P0 feature is in place. The only P1 gaps are script to video / AI clips and the size of the effects library (29 effects vs hundreds); everything else open is P2.

| Area | Feature | CapCut | VideoGen | Priority |
| --- | --- | --- | --- | --- |
| Timeline | Main track: add, reorder, delete clips | Yes | Have | P0 |
| Timeline | Split, trim by dragging edges | Yes | Have | P0 |
| Timeline | Undo / redo | Yes | Have | P0 |
| Timeline | Zoom, playhead, keyboard shortcuts | Yes | Have | P0 |
| Timeline | Multiple video tracks (overlay, picture-in-picture) | Yes | Have (overlay tracks; preview shows position, size, opacity) | P0 |
| Timeline | Snapping, magnetic timeline, ripple delete | Yes | Have (snap to playhead, edges, markers; ripple delete of an I/O range across all layers) | P1 |
| Timeline | Freeze frame, reverse clip | Yes | Have (reverse up to 10s of source; preview seeks without sound) | P1 |
| Timeline | Multi-select, copy / paste, group | Yes | Have (texts, overlays, audio and markers group; clips copy as a block) | P1 |
| Timeline | Markers, beat markers | Yes | Have (note and beat markers on the ruler; mark_beats) | P1 |
| Clip | Speed (constant) | Yes | Have | P0 |
| Clip | Speed curves (ramp) | Yes | Have (6 presets or custom points, audio pitch kept; smooth slow motion with frame blending or motion interpolation, export only) | P1 |
| Clip | Volume per clip, mute | Yes | Have | P0 |
| Clip | Fit modes: letterbox, crop, blurred background | Yes | Have | P0 |
| Clip | Crop, rotate, flip, position, scale | Yes | Have | P0 |
| Clip | Keyframes (position, scale, opacity, volume) | Yes | Have (clip scale/x/y/volume; overlay x/y/scale/opacity/rotate/volume; ease or linear) | P1 |
| Clip | Ken Burns zoom on photos | Yes (via keyframes / effects) | Have (6 zoom/pan presets) | P0 |
| Clip | Opacity and blend modes | Yes | Have (overlays: 8 blend modes; preview with CSS) | P2 |
| Visual | Color adjust: brightness, contrast, saturation, temperature | Yes | Have (plus vignette; clips and overlays) | P1 |
| Visual | Filters / LUTs | Yes (many presets) | Have (10 looks with intensity, .cube LUT import; LUTs not in the preview) | P1 |
| Visual | Video effects (shake, glitch, zoom pulse, light leaks) | Yes (hundreds) | Partial (29: shake, zoom pulse, glitch, RGB split, flash, blur, VHS, light leak, invert, pixelate, mirror, kaleidoscope, film grain, strobe, comic, letterbox, black & white, TV static, flicker, posterize, duotone, glow, rainbow, echo, swing, multi-screen, old film, night vision, thermal; preview approximates them) | P1 |
| Visual | Chroma key (green screen) | Yes | Have (overlays: green, blue or any color, similarity, edge, despill; export only) | P2 |
| Visual | Masks (shape, split) | Yes | Have (overlays: circle, rect with round corners, linear split, mirror band; feather, invert; preview with CSS masks) | P2 |
| Visual | Masks on main-track clips | Yes | Have (set_mask with clipId, in canvas fractions; preview with CSS masks) | P2 |
| Visual | Color curves, HSL, color wheels | Yes | Have (exposure, shadows, highlights, fade, hue, tint as tone curves shown in the preview; per-color HSL and shadow / midtone / highlight wheels; HSL export only) | P2 |
| Visual | Motion tracking (text or sticker follows an object) | Yes | Have (track_motion / ⌖ Track: drag a box, template matching, no AI; or 🙂 Follow face; overlays follow with keyframes) | P2 |
| Visual | Retouch / beauty (smooth skin, face reshape) | Yes | Missing | P2 |
| Transitions | Transitions between clips | Yes | Have (22 types) | P0 |
| Transitions | Real transition shown in preview | Yes | Have (CSS approximations of wipes, slides, circles, radial, zoom, fade to black/white) | P1 |
| Transitions | Clip in / out animations | Yes | Have (fade, zoom in/out, slide x4) | P1 |
| Text | Text overlays with position, size, color, box | Yes | Have | P0 |
| Text | Text in / out animations | Yes | Have (8 in, 5 out, all in the preview) | P1 |
| Text | Fonts, outline, shadow, styles presets | Yes | Have (any installed or imported font, 10 style presets incl. hook title and subscribe button) | P0 |
| Text | Text templates library (designed animated titles) | Yes (large library) | Partial (10 title templates: title card, lower third, quote, part label, countdown, big number, question hook, follow / subscribe, list, breaking news; CapCut has hundreds) | P2 |
| Text | Auto-captions from speech | Yes | Have (local Whisper, cached per file) | P0 |
| Text | Word-by-word karaoke captions | Yes | Have (karaoke, word highlight, single word, line) | P0 |
| Text | Stickers, emoji, GIFs | Yes | Have (😀 Sticker picker and add_sticker: color emoji stickers; transparent PNG and animated GIF stickers; color emoji on caption words; no animated GIF library) | P2 |
| Text | Translate captions (two languages, or a translated copy) | Yes | Have (translate_captions: Claude translates, the timing is kept; below / replace / copy; 🌐 button prefills the chat) | P1 |
| Text | Keyword highlight in captions | Yes | Have (emphasize_captions and ★ Keywords: own color, bigger, optional emoji above the line; Claude picks by meaning or auto picks numbers and strong words) | P1 |
| Text | Text to speech | Yes | Have (local Piper voices, free, auto-picked by language; or ElevenLabs with your API key for expressive voices and [excited]-style tags; Expressive slider; added as a voice track, so ducking, voice effects and captions apply; 🗣 Voice panel; no lipsync) | P1 |
| Audio | Music track with fades | Yes | Have | P0 |
| Audio | Multiple audio tracks, sound effects | Yes | Have (music / sfx / voice roles, numbered tracks) | P0 |
| Audio | Waveform on timeline | Yes | Have (audio items and clips with sound) | P1 |
| Audio | Beat detection, cut to the beat | Yes | Have (analyze_audio, mark_beats, fit_clips_to_beats) | P1 |
| Audio | Voiceover recording | Yes | Have (records from the playhead onto a voice track) | P1 |
| Audio | Ducking music under speech | Yes | Have (sidechain compression keyed by clip audio + voice; export only) | P1 |
| Audio | Noise reduction, voice effects | Yes | Have (noise reduction, 8 voice effects and pitch shift on clips, overlays and audio items; export only) | P2 |
| Audio | AI voice changer (turn a recording into another voice) | Yes | Partial (8 voice effects and pitch shift; new speech in any ElevenLabs or Piper voice, but no conversion of a recording) | P2 |
| Audio | Vocal isolation (separate voice and background music) | Yes | Missing | P2 |
| Clip | Auto zoom on talking heads (jump-cut framing, punch-ins) | Yes | Have (auto_zoom and 🔍 Auto zoom: every other jump cut framed tighter, punch-ins on highlighted or loudest words) | P1 |
| Audio | Edit by text (transcript), remove retakes | Yes (text-based editing) | Have (📝 Transcript panel: click to jump, select + Delete to cut; ↺ Remove retakes; get_timeline_transcript, cut_transcript, remove_retakes) | P1 |
| Audio | Studio voice (enhance speech) | Yes | Have (enhance_voice / 🎙 Studio voice: rumble cut, noise reduction, EQ, de-esser, compression; export only) | P1 |
| Clip | Stabilization | Yes | Have (stabilize_clip / 〰 Stabilize: two-pass vidstab, one-pass deshake after trims) | P2 |
| Visual | Color match between clips | Yes | Have (match_color / 🎨 Match others to this, as set_color values) | P2 |
| Timeline | Split screen and picture-in-picture layouts | Yes | Have (set_layout: top/bottom, side by side, circle or box picture-in-picture) | P2 |
| Media | B-roll over speech | Yes | Have (add_broll: at a phrase or time; auto by file name; Claude picks by looking at the media) | P2 |
| Export | Chapters, progress bar, hook and subscribe styles | Partial | Have (set_chapters: MP4 chapters + description list; set_progress_bar; text styles hook and subscribe) | P2 |
| Audio | Remove silences and filler words | Yes | Have (remove_silences and the ✂ Remove pauses button: cuts the quiet stretches between Whisper words and um/uh/ờ/ừm, one undo step, captions ripple) | P1 |
| Audio | Royalty-free music library | Yes | Have (🎵 Music / search_music + add_library_audio: free Creative Commons music and sound effects from Openverse, commercial + video licenses only, credits written next to each export) | P2 |
| AI | Background removal (no green screen) | Yes | Missing | P2 |
| AI | Auto reframe (16:9 to 9:16 following the subject) | Yes | Have (local face detector: the crop follows the main face, smooth within a shot, jumps at cuts; auto_reframe tool and ⌖ button, used by make_short; non-face subjects via reframe_clip with Claude reading gridded frames) | P1 |
| AI | Long video to short clips | Yes | Have (find_moments ranks moments from the local transcript, loudness and shot changes; Claude picks; make_short builds a captioned 9:16 project each; ✂ button in the media panel) | P2 |
| AI | Script to video, AI images / video clips | Yes | Missing (planned via VideoGen pipeline) | P1 |
| AI | Enhance / upscale, frame interpolation | Yes | Partial (no AI: sharpen and clean per clip, enhance_video, Lanczos scaling on export; frame interpolation as smooth slow motion; no AI super-resolution) | P2 |
| AI | AI avatars, talking photos | Yes | Missing | P2 |
| Media | Import video, image, audio; drag and drop | Yes | Have | P0 |
| Media | Thumbnails in library and on clips | Yes | Have | P0 |
| Media | Stock media library | Yes | Have (🎞 Stock / search_stock + add_stock: Pexels videos and photos with a free key, Openverse photos without; shape follows the canvas; as clip, B-roll or import) | P2 |
| Templates | Templates (fill a ready-made edit with your clips) | Yes | Have (save any edit as a template; slots keep length, framing, color, effects, transitions; music, beats, titles kept) | P1 |
| Templates | Online template marketplace (trending templates) | Yes | Missing (your own saved templates and 3 built-in styles) | P2 |
| Project | Multiple projects, save / open | Yes | Have | P0 |
| Project | Autosave | Yes | Have | P0 |
| Project | Cloud sync, team collaboration | Yes | Missing (local only on purpose: files stay on your PC) | P2 |
| Project | Proxy files for smooth 4K / HEVC editing | Yes | Have (automatic on import, 720p H.264) | P1 |
| Export | MP4 export, aspect ratios | Yes | Have (9:16, 16:9, 1:1, 4:5) | P0 |
| Export | Resolution, fps, bitrate choice | Yes | Have (480p-2160p, fps, Mbps, draft) | P1 |
| Export | Export cover image / thumbnail | Yes | Have (export_cover: full-size JPEG of any frame) | P1 |
| Export | GPU encoding | Yes | Have (NVENC, Quick Sync, AMF; encoder gpu/auto) | P2 |
| Export | Pre-posting check and safe-zone guide | Partial (safe-zone overlay) | Have (check_reel / ✓ Check: safe zones, hook, captions, reading speed, clips, audio, format; ▦ Safe zones overlay) | P1 |
| Export | Loudness normalization | Yes | Have (two-pass loudnorm after every export, -14 LUFS by default, set in Settings or per export) | P1 |
| Export | Publish to TikTok / YouTube / Facebook | Yes (TikTok, YouTube) | Missing | P2 |

## MCP server features

The MCP server is what lets Claude Code edit without an API key, so it needs every editor feature as a tool, plus ways for Claude to see and check its result. It now has 102 tools (101 shared with the editor plus import_media), 2 resources and 8 prompts. Every editing button in the browser calls one of these tools, so anything done by clicking can be done by Claude. Not available over MCP: API keys (on purpose; entered only in ⚙ Settings or environment variables) and microphone recording (import a recorded file instead).

| Feature | What it lets Claude do | VideoGen | Priority |
| --- | --- | --- | --- |
| One tool per editor feature | Every row above that we build gets a matching tool | Have for current features | P0 |
| Import files by path | Load clips from your disk | Have | P0 |
| See frames of source clips | Find moments ("where he jumps") | Have | P0 |
| See frames of the finished timeline | Check text placement, transitions, framing after editing | Have (look_at_timeline) | P0 |
| Transcribe speech (Whisper) | Make captions, cut on words, remove silences and filler words | Have (transcribe_asset, get_transcript, get_timeline_transcript, cut_transcript, remove_silences, remove_retakes) | P0 |
| Batch edits in one call | Apply many edits at once, faster and one undo step | Have (batch_edit) | P0 |
| Project as MCP resource | Read the full timeline JSON without a tool call | Have | P1 |
| Multiple projects | Create, open, duplicate, list projects | Have | P0 |
| Audio analysis | Detect beats, loudness, silence for cut-to-beat and ducking | Have (analyze_audio, mark_beats) | P1 |
| Templates and style presets | "Make it in my reel style": saved fonts, colors, caption style, intro, outro | Have (save_style / apply_style with 3 built-ins, save_template / create_from_template) | P1 |
| Export and wait | Render and return when done, with the file path | Have (export_video wait=true) | P1 |
| Prompts (MCP prompts) | Ready-made commands like "make a 30s reel from these clips" | Have (make_reel, reel_from_template, save_my_style, reframe_to_vertical, edit_talking_video, hook_and_chapters, translate_reel, shorts_from_video) | P2 |
| Check its own work | Find what goes wrong after posting before export | Have (check_reel: safe zones, hook, captions, audio, format; look_at_timeline) | P1 |
| Find free media | Pick music, sound effects and stock footage by mood or by looking at previews | Have (search_music / add_library_audio, search_stock / add_stock with previews) | P2 |
| Change saved settings | Switch the default voice, loudness target or font without the Settings dialog | Have (get_settings / update_settings; API keys stay out on purpose) | P2 |
| Generate media | Call image / video / voice models and drop results on the timeline | Missing | P1 |
| Remote access | Use the editor from Claude on phone or web, not only Claude Code on the same PC | Missing | P2 |

## Where VideoGen can beat CapCut

CapCut wins on effects and polish. VideoGen can win on automation, because Claude can do whole edits from one sentence.

- **Edit by describing:** "cut all silences, add captions, put the best 3 moments first" instead of 50 clicks.
- **Batch work:** make 10 reels from 10 folders, or 5 versions of one reel for A/B tests.
- **Content-aware edits:** Claude watches frames and reads the transcript, so it can pick highlights and place text where it does not cover faces.
- **Your own style as code:** a saved reel style (fonts, colors, caption look, intro, outro) applied the same way every time.
- **Connected to the AI video pipeline:** shot list, AI clips, voice and music go straight onto the timeline for a final touch-up.
- **No watermark, no subscription, private:** files stay on your PC, and there are no ToS terms over your uploads.

## Build order

Four phases, each usable on its own. Phase 1 covers everything a captioned reel needs.

1. **Phase 1, reel essentials (P0) — done Nov 2, 2026:** auto-captions with Whisper including word-by-word style, fonts and text presets, overlay track for picture-in-picture and logos, crop / position / scale, Ken Burns on photos, multiple projects, sound-effects track. MCP: timeline frame preview, transcribe, batch edits. Also shipped: project as MCP resource, export and wait, tool annotations. Still missing from the browser preview: clip transforms, Ken Burns and the new text styles (export and look_at_timeline show them); all shown in the preview since Nov 21, 2026.
2. **Phase 2, polish (P1) — done Nov 4, 2026:** keyframes, color adjust and 10 filter looks, 9 starter effects, clip in / out animations, waveforms, beat detection with beat markers and cut-to-beat, ducking, real transitions in preview, proxy files for 4K / HEVC, export resolution / fps / bitrate and GPU encoding. Not in the browser preview at the time: effects, ducking, vignette, crop (effects, vignette and crop added to the preview Nov 21, 2026). Left for later: .cube LUT import, more effects, speed ramps.
   - **Phase 2.5, code-only gaps (added Nov 5, 2026):** features that need only ffmpeg and our own code (no models, downloads or paid services).
     - **Quick wins (P1) — done Nov 5, 2026:** freeze frame, reverse clip, export cover image, snapping and ripple delete, multi-select with copy / paste / group, speed ramps (speed points per clip), .cube LUT import (`lut3d`), voiceover recording in the browser (saved as a voice track, so ducking and captions work with it).
     - **Extras (P2) — done Nov 21, 2026:** chroma key (`chromakey`), opacity and blend modes (`blend`) and noise reduction (`afftdn`) on Nov 20; on Nov 21 shape and split masks on overlays (`set_mask`), voice effects (chipmunk, deep, robot, echo, hall, telephone, radio, megaphone) and pitch shift, looping GIF and transparent image stickers with a pop-in animation, smooth slow motion (`minterpolate` blend or motion), and 6 more effects (pixelate, mirror, kaleidoscope, film grain, strobe, comic). Left: emoji stickers (libass can't draw color emoji) and a built-in sticker library.
     - **Preview gaps — done Nov 21, 2026:** effects (CSS filters and transforms, SVG filters for RGB split and comic, a canvas for pixelate / mirror / kaleidoscope, light leak and grain layers), Ken Burns, crop, vignette, and text in the export's own font files and sizes with outline, shadow, glow, box and every in / out animation including typewriter. Still export-only: LUTs, chroma key, removed regions, audio processing and smooth slow motion.
     - **Claude does the AI part:** a basic auto reframe (done Nov 20, 2026: `reframe_clip` + `look_at_asset` grid + `reframe_to_vertical` prompt), and long video to short clips (done Nov 21, 2026: `find_moments` lists candidate moments from transcript, loudness and scene changes for Claude to pick from, `make_short` turns each into a captioned 9:16 project, `shorts_from_video` prompt).
3. **Phase 3, AI and automation (P1):** reel style presets and templates (done Nov 5, 2026: styles with canvas, clip look, titles, captions, music mix, intro / outro / logo, applied in one step and kept as project defaults; 3 built-in styles; templates with slots; MCP prompts), auto reframe (done Nov 21, 2026: local face detector, `auto_reframe`), text to speech (done Nov 21, 2026: local Piper voices, `add_voiceover`), connect the AI video pipeline (generate clips and drop them on the timeline).
4. **Phase 4, extras (P2):** chroma key and masks (done Nov 20-21, 2026), stock media and music (done Nov 21, 2026), GIF stickers (done; no sticker or emoji library yet). Left: background removal, direct publishing, remote access.
5. **Talking-head and polish set (added and done Nov 21, 2026):** silence and filler removal, loudness normalization, keyword highlights with emoji, auto zoom, reel checker with safe zones, caption translation, edit by text, retakes, studio voice, stabilize, color match, split screen and picture-in-picture layouts, B-roll, chapters, progress bar.

Next (Nov 22, 2026): phases 1, 2, 2.5 and 5 are done, phase 3 is done except the AI pipeline, phase 4 is done except background removal, publishing and remote access. Text to speech uses Piper, plus ElevenLabs with an API key (OpenAI left out because its speech-endpoint models shut down 2027-01-06). Open, by priority:
   - **Done Nov 22, 2026 (no AI):** 14 more effects, color curves / HSL / wheels, masks on main clips, 10 title templates, emoji sticker picker, motion tracking (box or face), sharpen / clean / Lanczos upscaling, settings tools for MCP.
   - **P1:** script to video / AI images and clips (needs an image or video provider); still more effects.
   - **P2, local models:** background removal, vocal isolation, retouch.
   - **P2, needs a service or an account:** direct publishing, remote access, lipsync (sync.so, about $0.05/s; local Wav2Lip/MuseTalk need more GPU than the T550 has), AI avatars, AI upscaling.
   - **P2, large:** a template marketplace and a bigger text-design library.

### Auto-captions setup (added Nov 5, 2026)

All done: captions run on the dev machine (an i7-1260P laptop with 40 GB RAM and an NVIDIA T550 with 4 GB) with `ggml-large-v3-turbo-q5_0.bin` and `ggml-base.bin` in `models/`.

1. **Download a model (done: large-v3-turbo-q5_0 and base are in `models/`; small was the first plan):** `ggml-small.bin` (466 MB) into `models/`. It's the best balance of speed and Vietnamese accuracy on this machine.
2. **Auto-detect the more accurate model (done Nov 20, 2026; turbo takes 3.4s for the 5.5s speech fixture on CPU, base 0.9s):** add `ggml-large-v3-turbo-q5_0.bin` (~550 MB, close to large-v3 accuracy) to the model search in `src/transcribe.js` and prefer it over small when both are present. Today only base, small and tiny are found without `VIDEOGEN_WHISPER_MODEL`.
3. **Check GPU use (done Nov 20, 2026: the GPU is used; 55s of speech takes 9s on GPU vs 51s on CPU with turbo):** time `test/fixtures/speech.mp3` with `use_gpu` on and off to see whether this ffmpeg build uses the T550. Note the result in CLAUDE.md.
4. **Skip silence with VAD (done Nov 20, 2026, differently: ffmpeg's Silero VAD was 7x slower and still gave early word times and made-up words, so long silences are cut in our own code before whisper and word times mapped back):** pass ffmpeg's `vad_model` (Silero) when the file is present, so long clips with silences transcribe faster and leave out made-up words in quiet parts.
5. **Captions button in the browser (done Nov 20, 2026: CC Captions in the timeline toolbar, preset and language remembered, changing the preset restyles existing captions):** caption preset and language picker that runs `add_captions`, with a clear message when no model is installed (and where to get one).
6. **Docs (done Nov 20, 2026):** a model setup section in the README (which model for which machine, download command). The outdated "Known limits" lines were already replaced on Nov 5, 2026.
7. **Test (done: the smoke test's captions step runs now that a model is in models/):** with the model in place, `npm test` runs the smoke test's captions step instead of skipping it.
