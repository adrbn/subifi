# Sub-Easy-Ifi

Internal video subtitle editor. Upload a video, transcribe the voices with
Groq Whisper-large-v3, fix/style the subtitles in a WYSIWYG editor, export
SRT/VTT/TXT/JSON files and/or burn styled subtitles directly into an MP4.

Runs 100% in the browser for everything except a thin `/api/transcribe`
proxy that calls Groq. Deploys to Vercel with zero infrastructure.

## Requirements

- Node.js 20+
- A Groq API key (free tier is enough — get one at https://console.groq.com)

## Quick start

```bash
npm install
cp .env.example .env.local
# edit .env.local and paste your GROQ_API_KEY
npm run dev
# open http://localhost:3000
```

## Deploy on Vercel

1. Push this repo to GitHub / GitLab / Bitbucket.
2. Import it into Vercel.
3. Add the environment variable **GROQ_API_KEY** in project settings.
4. Deploy — no other config needed.

## How it works

1. You drop a video (any format supported by the browser) onto the dropzone.
2. `ffmpeg.wasm` extracts the audio track into Opus 64 kbps mono (~2-3 MB for
   5 min) so it stays safely under Groq's 25 MB limit.
3. The audio is POSTed to `/api/transcribe`, which forwards it to Groq
   Whisper-large-v3 and returns word-level timestamps.
4. A segmenter turns the words into subtitle blocks (cinema preset by default,
   switchable to TikTok / custom).
5. You edit text inline, drag block times on the mini-timeline, tune the style
   in the right panel, and see everything live in the preview.
6. Export:
   - **SRT / VTT / TXT / JSON** — generated in-browser, instant download.
   - **MP4 (burned)** — `ffmpeg.wasm` renders the styled subtitles into the
     video using the `subtitles` (libass) filter. Takes a few seconds to a
     minute depending on video length.

## Tech

- **Next.js 15** (App Router) + React 19 + TypeScript
- **Tailwind CSS** for styling
- **Zustand** for state
- **ffmpeg.wasm** for audio extraction and subtitle burn-in
- **Groq SDK** for Whisper transcription

## Notes

- COOP/COEP headers are enabled globally so `SharedArrayBuffer` is available
  to ffmpeg.wasm (`credentialless` mode so Google Fonts still work).
- The `/api/transcribe` route has an in-memory rate limit (10 req/min/IP) to
  deter casual abuse. It resets on cold start.
- No persistence: close the tab and you lose your work. Export early, export
  often.

## Out of scope (for now)

- Speaker diarization
- Waveform in the timeline
- Undo/redo
- Multi-project persistence / authentication
- Mobile UI

See `docs/superpowers/specs/2026-04-09-sub-easy-ifi-design.md` for the full
design rationale.
