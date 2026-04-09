import { NextResponse } from 'next/server';
import Groq from 'groq-sdk';
import { checkRateLimit, clientKeyFromRequest } from '@/lib/rate-limit';

// Node runtime: Groq SDK + form handling work out of the box. Edge runtime
// is technically faster but we want the Node APIs for streaming and the
// groq-sdk (which uses node-fetch internals) works more reliably on Node.
export const runtime = 'nodejs';
export const maxDuration = 60;

type Segment = {
  start: number;
  end: number;
  text: string;
};

type VerboseTranscription = {
  text: string;
  segments?: Segment[];
  words?: { word: string; start: number; end: number }[];
};

export async function POST(req: Request) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: 'GROQ_API_KEY is not configured on the server' },
      { status: 500 },
    );
  }

  const key = clientKeyFromRequest(req);
  const limit = checkRateLimit(key);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Slow down.' },
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.ceil(limit.retryAfterMs / 1000)),
        },
      },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: 'Expected multipart/form-data body' },
      { status: 400 },
    );
  }

  const audio = form.get('audio');
  const language = (form.get('language') as string | null) ?? undefined;
  if (!(audio instanceof File)) {
    return NextResponse.json(
      { error: 'Missing "audio" file field' },
      { status: 400 },
    );
  }

  // Groq rejects payloads > 25 MB. We extract audio client-side to Opus 64k
  // mono so we never get close to this — but we still guard for safety.
  if (audio.size > 24 * 1024 * 1024) {
    return NextResponse.json(
      { error: 'Audio file too large (>24 MB after client-side extraction)' },
      { status: 413 },
    );
  }

  const groq = new Groq({ apiKey });

  try {
    const result = (await groq.audio.transcriptions.create({
      file: audio,
      model: 'whisper-large-v3',
      response_format: 'verbose_json',
      timestamp_granularities: ['word', 'segment'],
      language,
    })) as unknown as VerboseTranscription;

    const words =
      result.words?.map((w) => ({
        text: w.word,
        start: w.start,
        end: w.end,
      })) ?? [];

    // Fallback: if the API didn't return word-level timing for some reason,
    // synthesize one "word" per segment so the editor still has something to
    // segment with.
    const fallback =
      words.length === 0
        ? (result.segments ?? []).map((s) => ({
            text: s.text.trim(),
            start: s.start,
            end: s.end,
          }))
        : [];

    return NextResponse.json({
      language: language ?? null,
      text: result.text,
      words: words.length > 0 ? words : fallback,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json(
      { error: `Groq transcription failed: ${message}` },
      { status: 502 },
    );
  }
}
