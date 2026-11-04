# VideoGen feature list vs CapCut

Nov 2, 2026 · @Ngoc

VideoGen already covers the core of a short-form editor (cut, trim, speed, transitions, text, music, export). The biggest gaps against CapCut are auto-captions, multi-track overlays, keyframes, filters and the AI tools. The MCP server needs a few more tools so Claude can check its own work.

CapCut features below come from its desktop and mobile apps as I know them (approximate, not checked against today's release notes).

- **Status:** Have = works in the MVP now. Partial = basic version exists. Missing = not built.
- **Priority:** P0 = needed to make reels like the islandboyjuju ones. P1 = makes it a real CapCut alternative. P2 = nice to have.

## Editor features vs CapCut

Of the 57 CapCut features listed, VideoGen has 34 and 3 more in part (updated after Phase 2, Nov 4, 2026). Every P0 editor feature and most P1 polish features are in place; the remaining gaps are mostly AI, templates and P2 extras.

| Area | Feature | CapCut | VideoGen | Priority |
| --- | --- | --- | --- | --- |
| Timeline | Main track: add, reorder, delete clips | Yes | Have | P0 |
| Timeline | Split, trim by dragging edges | Yes | Have | P0 |
| Timeline | Undo / redo | Yes | Have | P0 |
| Timeline | Zoom, playhead, keyboard shortcuts | Yes | Have | P0 |
| Timeline | Multiple video tracks (overlay, picture-in-picture) | Yes | Have (overlay tracks; preview shows position, size, opacity) | P0 |
| Timeline | Snapping, magnetic timeline, ripple delete | Yes | Partial (main track is magnetic) | P1 |
| Timeline | Freeze frame, reverse clip | Yes | Missing | P1 |
| Timeline | Multi-select, copy / paste, group | Yes | Missing | P1 |
| Timeline | Markers, beat markers | Yes | Have (note and beat markers on the ruler; mark_beats) | P1 |
| Clip | Speed (constant) | Yes | Have | P0 |
| Clip | Speed curves (ramp) | Yes | Missing | P1 |
| Clip | Volume per clip, mute | Yes | Have | P0 |
| Clip | Fit modes: letterbox, crop, blurred background | Yes | Have | P0 |
| Clip | Crop, rotate, flip, position, scale | Yes | Have (preview shows all but crop) | P0 |
| Clip | Keyframes (position, scale, opacity, volume) | Yes | Have (clip scale/x/y/volume; overlay x/y/scale/opacity/rotate/volume; ease or linear) | P1 |
| Clip | Ken Burns zoom on photos | Yes (via keyframes / effects) | Have (6 zoom/pan presets; export only, not in preview) | P0 |
| Clip | Opacity and blend modes | Yes | Missing | P2 |
| Visual | Color adjust: brightness, contrast, saturation, temperature | Yes | Have (plus vignette; clips and overlays) | P1 |
| Visual | Filters / LUTs | Yes (many presets) | Partial (10 looks with intensity; no .cube LUT import yet) | P1 |
| Visual | Video effects (shake, glitch, zoom pulse, light leaks) | Yes (hundreds) | Partial (9: shake, zoom pulse, glitch, RGB split, flash, blur, VHS, light leak, invert; export only) | P1 |
| Visual | Chroma key (green screen) | Yes | Missing | P2 |
| Visual | Masks (shape, split) | Yes | Missing | P2 |
| Transitions | Transitions between clips | Yes | Have (22 types) | P0 |
| Transitions | Real transition shown in preview | Yes | Have (CSS approximations of wipes, slides, circles, radial, zoom, fade to black/white) | P1 |
| Transitions | Clip in / out animations | Yes | Have (fade, zoom in/out, slide x4) | P1 |
| Text | Text overlays with position, size, color, box | Yes | Have | P0 |
| Text | Text in / out animations | Yes | Have (8 in, 5 out; preview shows only fade, pop, slide up) | P1 |
| Text | Fonts, outline, shadow, styles presets | Yes | Have (any installed or imported font, 8 style presets) | P0 |
| Text | Auto-captions from speech | Yes | Have (local Whisper, cached per file) | P0 |
| Text | Word-by-word karaoke captions | Yes | Have (karaoke, word highlight, single word, line) | P0 |
| Text | Stickers, emoji, GIFs | Yes | Missing | P2 |
| Text | Text to speech | Yes | Missing | P1 |
| Audio | Music track with fades | Yes | Have | P0 |
| Audio | Multiple audio tracks, sound effects | Yes | Have (music / sfx / voice roles, numbered tracks) | P0 |
| Audio | Waveform on timeline | Yes | Have (audio items and clips with sound) | P1 |
| Audio | Beat detection, cut to the beat | Yes | Have (analyze_audio, mark_beats, fit_clips_to_beats) | P1 |
| Audio | Voiceover recording | Yes | Missing | P1 |
| Audio | Ducking music under speech | Yes | Have (sidechain compression keyed by clip audio + voice; export only) | P1 |
| Audio | Noise reduction, voice effects | Yes | Missing | P2 |
| Audio | Royalty-free music library | Yes | Missing | P2 |
| AI | Background removal (no green screen) | Yes | Missing | P2 |
| AI | Auto reframe (16:9 to 9:16 following the subject) | Yes | Missing | P1 |
| AI | Long video to short clips | Yes | Missing | P2 |
| AI | Script to video, AI images / video clips | Yes | Missing (planned via VideoGen pipeline) | P1 |
| AI | Enhance / upscale, frame interpolation | Yes | Missing | P2 |
| Media | Import video, image, audio; drag and drop | Yes | Have | P0 |
| Media | Thumbnails in library and on clips | Yes | Have | P0 |
| Media | Stock media library | Yes | Missing | P2 |
| Templates | Templates (fill a ready-made edit with your clips) | Yes | Missing | P1 |
| Project | Multiple projects, save / open | Yes | Have | P0 |
| Project | Autosave | Yes | Have | P0 |
| Project | Proxy files for smooth 4K / HEVC editing | Yes | Have (automatic on import, 720p H.264) | P1 |
| Export | MP4 export, aspect ratios | Yes | Have (9:16, 16:9, 1:1, 4:5) | P0 |
| Export | Resolution, fps, bitrate choice | Yes | Have (480p-2160p, fps, Mbps, draft) | P1 |
| Export | Export cover image / thumbnail | Yes | Missing | P1 |
| Export | GPU encoding | Yes | Have (NVENC, Quick Sync, AMF; encoder gpu/auto) | P2 |
| Export | Publish to TikTok / YouTube / Facebook | Yes (TikTok, YouTube) | Missing | P2 |

## MCP server features

The MCP server is what lets Claude Code edit without an API key, so it needs every editor feature as a tool, plus ways for Claude to see and check its result. It now has 52 tools (53 with import_media) covering clips, color, effects, keyframes, overlays, text, captions, audio analysis and beats, projects, batch edits, timeline frames, undo and export.

| Feature | What it lets Claude do | VideoGen | Priority |
| --- | --- | --- | --- |
| One tool per editor feature | Every row above that we build gets a matching tool | Have for current features | P0 |
| Import files by path | Load clips from your disk | Have | P0 |
| See frames of source clips | Find moments ("where he jumps") | Have | P0 |
| See frames of the finished timeline | Check text placement, transitions, framing after editing | Have (look_at_timeline) | P0 |
| Transcribe speech (Whisper) | Make captions, cut on words, remove silences and filler words | Have (transcribe_asset, get_transcript) | P0 |
| Batch edits in one call | Apply many edits at once, faster and one undo step | Have (batch_edit) | P0 |
| Project as MCP resource | Read the full timeline JSON without a tool call | Have | P1 |
| Multiple projects | Create, open, duplicate, list projects | Have | P0 |
| Audio analysis | Detect beats, loudness, silence for cut-to-beat and ducking | Have (analyze_audio, mark_beats) | P1 |
| Templates and style presets | "Make it in my reel style": saved fonts, colors, caption style, intro, outro | Missing | P1 |
| Export and wait | Render and return when done, with the file path | Have (export_video wait=true) | P1 |
| Prompts (MCP prompts) | Ready-made commands like "make a 30s reel from these clips" | Missing | P2 |
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

1. **Phase 1, reel essentials (P0) — done Nov 2, 2026:** auto-captions with Whisper including word-by-word style, fonts and text presets, overlay track for picture-in-picture and logos, crop / position / scale, Ken Burns on photos, multiple projects, sound-effects track. MCP: timeline frame preview, transcribe, batch edits. Also shipped: project as MCP resource, export and wait, tool annotations. Still missing from the browser preview: clip transforms, Ken Burns and the new text styles (export and look_at_timeline show them).
2. **Phase 2, polish (P1) — done Nov 4, 2026:** keyframes, color adjust and 10 filter looks, 9 starter effects, clip in / out animations, waveforms, beat detection with beat markers and cut-to-beat, ducking, real transitions in preview, proxy files for 4K / HEVC, export resolution / fps / bitrate and GPU encoding. Not in the browser preview: effects, ducking, vignette, crop (export and look_at_timeline show them). Left for later: .cube LUT import, more effects, speed ramps.
3. **Phase 3, AI and automation (P1):** reel style presets and templates, auto reframe, text to speech, connect the AI video pipeline (generate clips and drop them on the timeline).
4. **Phase 4, extras (P2):** stickers, chroma key, masks, background removal, stock media and music, direct publishing, remote access.

Next: Phase 3 (reel style presets and templates, auto reframe, text to speech, AI pipeline).
