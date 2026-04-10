import { NextResponse } from 'next/server';
import Groq from 'groq-sdk';
import { checkRateLimit, clientKeyFromRequest } from '@/lib/rate-limit';

// Translates an array of subtitle blocks to a target language using the
// Groq LLM API. We send the texts as a numbered list and ask the model to
// echo them back in the same order — this is more robust than translating
// one block at a time (preserves context, avoids per-call latency, and is
// cheap with llama-3.1-8b-instant).

export const runtime = 'nodejs';
export const maxDuration = 60;

type TranslateRequest = {
  texts: string[];
  targetLang: string;
  // OPTIONAL: the full transcript (every block, in order) so the model has
  // the surrounding context even when we batch. Each `texts[i]` MUST also
  // appear inside `transcriptContext` — the model will only translate the
  // ones we ask for, but it can read the rest to disambiguate pronouns,
  // tense, names, etc. Older clients that don't pass this still work, the
  // prompt just falls back to the batch-only flow.
  transcriptContext?: string[];
};

const MAX_TEXTS_PER_REQUEST = 200;
const MAX_TOTAL_CHARS = 60_000;
// Hard cap on the context block. Llama-3.1-8b-instant is small (8k ctx);
// pushing the entire transcript is fine for short clips but we trim to
// keep latency / cost predictable on long ones.
const MAX_CONTEXT_CHARS = 30_000;

function trimContext(lines: string[]): string[] {
  let total = 0;
  const out: string[] = [];
  for (const line of lines) {
    if (total + line.length > MAX_CONTEXT_CHARS) break;
    out.push(line);
    total += line.length;
  }
  return out;
}

function buildPrompt(
  texts: string[],
  targetLang: string,
  transcriptContext?: string[],
): string {
  const numbered = texts
    .map((t, i) => `${i + 1}. ${t.replace(/\n/g, ' ').trim()}`)
    .join('\n');

  const contextSection =
    transcriptContext && transcriptContext.length > 0
      ? [
          `Full transcript (for CONTEXT ONLY — do NOT translate, do NOT echo this section):`,
          ...trimContext(transcriptContext).map((t) =>
            `> ${t.replace(/\n/g, ' ').trim()}`,
          ),
          ``,
        ]
      : [];

  return [
    `You are translating SUBTITLES of a single coherent piece of content.`,
    `Use the full transcript above for context (tone, characters, ongoing topic) so your translation stays consistent across lines.`,
    ...contextSection,
    `Translate ONLY the following subtitle lines to ${targetLang}.`,
    `Rules:`,
    `- Output ONLY the numbered translated lines, in the same order, with the same numbering.`,
    `- Preserve meaning and tone — natural, idiomatic ${targetLang}.`,
    `- Stay consistent with the rest of the transcript (don't re-introduce a character whose name was already established earlier).`,
    `- One line per input. Do not merge or split lines.`,
    `- Do not add commentary, headers, or quotes.`,
    ``,
    numbered,
  ].join('\n');
}

// Parse the model's response back into an array indexed by input position.
// We tolerate slight formatting drift (extra blank lines, missing numbers
// on some rows) by walking the response top-to-bottom and using the
// numeric prefix when present, otherwise falling back to sequential.
function parseResponse(raw: string, expectedCount: number): string[] {
  const out = new Array<string>(expectedCount).fill('');
  const lines = raw.split('\n');
  let cursor = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\d+)[.)]\s*(.+)$/);
    if (m) {
      const idx = Number(m[1]) - 1;
      if (idx >= 0 && idx < expectedCount) {
        out[idx] = m[2].trim();
        cursor = idx + 1;
        continue;
      }
    }
    // No numeric prefix — append to the previous slot or take the next one.
    if (cursor < expectedCount) {
      out[cursor] = trimmed;
      cursor++;
    }
  }
  return out;
}

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

  let body: TranslateRequest;
  try {
    body = (await req.json()) as TranslateRequest;
  } catch {
    return NextResponse.json(
      { error: 'Expected JSON body { texts: string[], targetLang: string }' },
      { status: 400 },
    );
  }

  if (
    !body ||
    !Array.isArray(body.texts) ||
    typeof body.targetLang !== 'string' ||
    body.targetLang.trim() === ''
  ) {
    return NextResponse.json(
      { error: 'Body must include non-empty texts[] and targetLang' },
      { status: 400 },
    );
  }

  if (
    body.transcriptContext !== undefined &&
    (!Array.isArray(body.transcriptContext) ||
      body.transcriptContext.some((t) => typeof t !== 'string'))
  ) {
    return NextResponse.json(
      { error: 'transcriptContext must be an array of strings if provided' },
      { status: 400 },
    );
  }

  if (body.texts.length === 0) {
    return NextResponse.json({ translations: [] });
  }
  if (body.texts.length > MAX_TEXTS_PER_REQUEST) {
    return NextResponse.json(
      { error: `Too many texts (max ${MAX_TEXTS_PER_REQUEST} per request)` },
      { status: 413 },
    );
  }
  const totalChars = body.texts.reduce((acc, t) => acc + t.length, 0);
  if (totalChars > MAX_TOTAL_CHARS) {
    return NextResponse.json(
      { error: `Total text too large (max ${MAX_TOTAL_CHARS} chars)` },
      { status: 413 },
    );
  }

  const groq = new Groq({ apiKey });
  try {
    const completion = await groq.chat.completions.create({
      // 8b-instant is cheap, fast, and plenty good for short subtitle text.
      model: 'llama-3.1-8b-instant',
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content:
            'You are a professional subtitle translator. Output only the translated lines, numbered, in the same order as the input. No preface, no explanation.',
        },
        {
          role: 'user',
          content: buildPrompt(
            body.texts,
            body.targetLang,
            body.transcriptContext,
          ),
        },
      ],
    });
    const raw = completion.choices[0]?.message?.content ?? '';
    const translations = parseResponse(raw, body.texts.length);
    return NextResponse.json({ translations });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json(
      { error: `Groq translation failed: ${message}` },
      { status: 502 },
    );
  }
}
