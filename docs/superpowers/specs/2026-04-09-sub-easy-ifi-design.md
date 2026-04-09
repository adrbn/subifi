# Sub-Easy-Ifi — Design Spec

**Date:** 2026-04-09
**Status:** Approved, implementation in progress
**Scope:** MVP, internal tool

## Goal

Web app hosted on Vercel where any video can be uploaded, voices transcribed,
exported as subtitle files (SRT/VTT/TXT/JSON), and/or burned into a styled
output MP4. The editor lets you fix transcription, adjust timings, and style
subtitles (font, colors, background, radius, position, size) with live preview.

## Constraints (decided during brainstorming)

| Decision | Choice | Consequence |
|---|---|---|
| Target videos | Short (≤ 5 min, < 200 MB) | 100% client-side processing viable |
| Transcription | Groq Whisper-large-v3 | ~free, 10-50x realtime, FR + IT |
| Persistence | None (one-shot) | No DB, no storage, no auth required |
| Access | Public URL + per-IP rate limit | Zero auth plumbing |
| Layout | Hybrid balanced | Preview top, mini-timeline middle, editable list bottom, style panel side |
| Segmentation | Cinema + TikTok presets, sliders, re-segment button | Max flexibility, cinema default |
| Exports | SRT, VTT, TXT, JSON, MP4 H.264 burned | |
| Fonts | Google Fonts picker + local upload (IndexedDB) | |
| Style presets | 4 (Cinéma, TikTok, Minimal, News) | |

## Architecture

**100% client-first SPA.** The only server touch point is `/api/transcribe`,
which proxies the audio file to Groq (keeps the API key secret).

```
Browser                                       Vercel
┌─────────────────────────────┐              ┌────────────────────┐
│ Next.js 15 App              │              │ /api/transcribe    │
│                             │              │ (Node runtime)     │
│ Upload → IndexedDB          │              │                    │
│     │                       │              │ - rate limit by IP │
│     ▼                       │              │ - forward to Groq  │
│ ffmpeg.wasm: extract audio  │              │ - return JSON      │
│     │                       │  POST audio  │                    │
│     ├─────────────────────────────────────▶│                    │
│     │                       │  JSON words  │                    │
│     │◀─────────────────────────────────────│                    │
│     ▼                       │              └────────┬───────────┘
│ Segmenter → Zustand store   │                       │
│     ▼                       │                       ▼
│ Editor (live DOM overlay)   │              ┌────────────────────┐
│     │                       │              │ Groq API           │
│     ▼                       │              │ whisper-large-v3   │
│ Export:                     │              └────────────────────┘
│  - SRT/VTT/TXT/JSON (JS)    │
│  - MP4 burn (ffmpeg.wasm + ASS filter)
└─────────────────────────────┘
```

### Data model

```ts
type Word = { text: string; start: number; end: number };

type SubtitleBlock = {
  id: string;
  start: number;   // seconds
  end: number;     // seconds
  text: string;    // may be multiline (\n)
  words?: Word[];  // preserved from Whisper for re-segmentation
};

type Style = {
  fontFamily: string;          // Google Fonts or uploaded custom
  fontSize: number;            // px
  fontWeight: number;
  textColor: string;           // hex
  textOutlineColor: string;    // hex
  textOutlineWidth: number;    // px
  backgroundColor: string;     // hex or "transparent"
  backgroundOpacity: number;   // 0..1
  backgroundPaddingX: number;  // px
  backgroundPaddingY: number;  // px
  backgroundRadius: number;    // px
  positionX: number;           // 0..1 (center of textbox, fraction of video width)
  positionY: number;           // 0..1
  maxWidth: number;            // 0..1 (fraction of video width)
  textAlign: 'left' | 'center' | 'right';
};

type SegmentationConfig = {
  mode: 'cinema' | 'tiktok' | 'custom';
  maxCharsPerLine: number;
  maxLines: number;
  maxDurationSec: number;
  minDurationSec: number;
};

type ProjectState = {
  videoFile: File | null;
  videoUrl: string | null;    // object URL
  videoDuration: number;
  videoWidth: number;
  videoHeight: number;
  words: Word[];              // raw Whisper output
  blocks: SubtitleBlock[];
  style: Style;
  segmentation: SegmentationConfig;
  customFonts: { name: string; dataUrl: string }[];
  status: 'idle' | 'extracting' | 'transcribing' | 'ready' | 'burning' | 'error';
  error: string | null;
};
```

### File structure

```
sub-easy-ifi/
├── app/
│   ├── layout.tsx
│   ├── page.tsx                # composes editor
│   ├── globals.css
│   └── api/
│       └── transcribe/
│           └── route.ts
├── components/
│   ├── Dropzone.tsx
│   ├── VideoPreview.tsx
│   ├── SubtitleList.tsx
│   ├── Timeline.tsx
│   ├── StylePanel.tsx
│   ├── FontPicker.tsx
│   ├── PresetsBar.tsx
│   ├── ExportBar.tsx
│   └── ui/                     # minimal shadcn-style primitives
│       ├── button.tsx
│       ├── slider.tsx
│       ├── input.tsx
│       └── select.tsx
├── lib/
│   ├── store.ts                # Zustand
│   ├── types.ts
│   ├── presets.ts              # 4 style presets
│   ├── segmenter.ts            # cinema & tiktok logic
│   ├── subtitle-formats.ts     # srt/vtt/txt/json serializers
│   ├── ass-generator.ts        # state -> ASS file
│   ├── ffmpeg-client.ts        # singleton loader
│   ├── audio-extract.ts        # video -> opus
│   ├── burn-in.ts              # video + ASS -> MP4
│   ├── google-fonts.ts         # fetch + inject Google Fonts
│   ├── rate-limit.ts           # in-memory per-IP bucket
│   └── download.ts             # trigger file download
├── public/
├── next.config.ts              # COOP/COEP headers
├── package.json
├── tsconfig.json
├── tailwind.config.ts
├── postcss.config.js
├── .env.example
├── .gitignore
└── README.md
```

## Non-trivial implementation notes

### COOP/COEP for ffmpeg.wasm

`ffmpeg.wasm` requires `SharedArrayBuffer`, which requires:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

`credentialless` is used instead of `require-corp` so Google Fonts and other
third-party resources work without CORP headers.

### Groq file size limit

Groq has a 25 MB upload limit. For 5 min of audio at opus 64 kbps mono → ~2.4 MB.
Safe margin. The audio extraction step is mandatory — we never upload the raw video.

### Vercel body size limit

Node runtime default limit is 4.5 MB. We explicitly set `maxDuration: 60` and
rely on Next.js 15 which uses the Web Streams API for the body (no hard limit
on App Router route handlers). Our audio payload is ≤ 3 MB anyway.

### Rate limiting

In-memory token bucket keyed on `x-forwarded-for`. Resets on cold start — not
perfect but sufficient to deter casual abuse. 10 requests / minute / IP.

### Style → ASS mapping

ASS styles don't 1:1 match CSS. Specifically:
- `BackColour` + `BorderStyle=3` → box background
- `Outline` → text stroke width
- `OutlineColour` → text stroke color
- `MarginL/R/V` → position (we compute from `positionX/Y`)
- Custom font: we copy the font file into ffmpeg's virtual FS as `fonts/<name>.ttf`
  and use the `fontsdir=fonts` option in the `subtitles` filter.

### DOM overlay vs ASS fidelity

Known limitation: the DOM preview uses CSS (text-shadow, padding, background)
while the final render uses libass. Small sub-pixel differences can occur
(especially on outline rendering). Documented in the README; acceptable for
MVP. Upgrade path = JASSUB preview (Approach 2).

## Out of scope (MVP)

- Speaker diarization
- Waveform in the timeline
- Undo/redo
- Multi-project / persistence / auth
- Batch upload
- Keyboard shortcuts beyond play/pause
- Side-by-side compare view
- ASS/SSA export (only used internally for burning)
- Mobile UI (desktop-first)

## Success criteria

1. Upload a 3-min MP4 → see editable subtitles within ~30 s
2. Edit text of any block inline
3. Change font + colors → preview updates instantly
4. Click a preset → all styles swap atomically
5. Adjust block timings via the list
6. Re-segment from cinema to tiktok → blocks rebuild
7. Export SRT file matches what's visible in the editor
8. Export MP4 with burned subtitles matches the preview (modulo known sub-pixel drift)
9. Deploys to Vercel with no manual config beyond setting `GROQ_API_KEY`
