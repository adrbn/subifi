import { splitAudioBytes } from './audio-chunk';

// Shared transcription driver for TranscribeButton + TranscribeInlineButton.
// Picks a single-request fast path for short audio, otherwise splits into
// ~20-minute chunks so each upload stays under Groq's 25 MB cap, then
// shifts each chunk's word timings back into the original timeline.

export type Word = { text: string; start: number; end: number };
export type TranscribeProgress = (done: number, total: number) => void;

// 4 MB — Vercel Serverless Functions reject bodies >4.5 MB by default on
// Hobby/Pro. Anything larger MUST be chunked or the deployed site returns
// 413 before the handler ever runs. Local dev could go higher, but the
// same threshold keeps behavior identical across environments.
const SINGLE_SHOT_THRESHOLD_BYTES = 4 * 1024 * 1024;

async function postChunk(
  bytes: Uint8Array,
  offsetSec: number,
): Promise<Word[]> {
  const fd = new FormData();
  fd.append(
    'audio',
    new Blob([bytes as BlobPart], { type: 'audio/ogg' }),
    'audio.ogg',
  );
  const res = await fetch('/api/transcribe', { method: 'POST', body: fd });
  if (!res.ok) {
    const j = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(j.error || `Transcription failed (${res.status})`);
  }
  const json = (await res.json()) as { words?: Word[] };
  const words = json.words ?? [];
  if (offsetSec === 0) return words;
  return words.map((w) => ({
    text: w.text,
    start: w.start + offsetSec,
    end: w.end + offsetSec,
  }));
}

export async function transcribeAudio(
  bytes: Uint8Array,
  totalDurationSec: number,
  onProgress?: TranscribeProgress,
): Promise<Word[]> {
  if (bytes.byteLength <= SINGLE_SHOT_THRESHOLD_BYTES) {
    onProgress?.(0, 1);
    const words = await postChunk(bytes, 0);
    onProgress?.(1, 1);
    return words;
  }

  const chunks = await splitAudioBytes(bytes, totalDurationSec);
  const all: Word[] = [];
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.(i, chunks.length);
    const w = await postChunk(chunks[i].bytes, chunks[i].startSec);
    all.push(...w);
  }
  onProgress?.(chunks.length, chunks.length);
  return all;
}
