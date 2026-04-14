import { NextResponse } from 'next/server';
import { checkRateLimit, clientKeyFromRequest } from '@/lib/rate-limit';
import {
  getSharedPresetStore,
  type SharedPreset,
} from '@/lib/shared-presets-store';
import type { Style } from '@/lib/types';

// Public, no-auth community library of subtitle style presets. Anyone can
// list or publish — we lean on the rate limiter to deter abuse, and cap
// label length + style size on the server so payloads stay small.
//
// Shape the client speaks:
//   GET    /api/presets          -> { presets: SharedPreset[] }
//   POST   /api/presets          -> { preset: SharedPreset }
//     body: { label: string, style: Style }
//   DELETE /api/presets?id=XXX   -> { ok: true }
//     No auth — matches the public-by-design stance of the rest of this
//     endpoint. Rate-limited like POST to deter mass purges.

export const runtime = 'nodejs';
export const maxDuration = 10;

const MAX_LABEL_CHARS = 60;
const MAX_STYLE_BYTES = 8_000;

type PostBody = {
  label: unknown;
  style: unknown;
};

function isStyle(value: unknown): value is Style {
  // Structural check — we only care that it's an object with the fields the
  // editor will actually read. Unknown extra fields are harmless; the editor
  // merges over DEFAULT_STYLE at apply time.
  return typeof value === 'object' && value !== null;
}

export async function GET() {
  const store = getSharedPresetStore();
  const presets = await store.list();
  return NextResponse.json({ presets });
}

export async function POST(req: Request) {
  const key = clientKeyFromRequest(req);
  const limit = checkRateLimit(key);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Slow down.' },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil(limit.retryAfterMs / 1000)) },
      },
    );
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (typeof body.label !== 'string' || body.label.trim().length === 0) {
    return NextResponse.json({ error: 'label required' }, { status: 400 });
  }
  if (body.label.length > MAX_LABEL_CHARS) {
    return NextResponse.json(
      { error: `label exceeds ${MAX_LABEL_CHARS} chars` },
      { status: 400 },
    );
  }
  if (!isStyle(body.style)) {
    return NextResponse.json({ error: 'style required' }, { status: 400 });
  }
  // Size check — prevents a single preset with embedded junk from
  // bloating the shared list.
  const serialized = JSON.stringify(body.style);
  if (serialized.length > MAX_STYLE_BYTES) {
    return NextResponse.json(
      { error: `style exceeds ${MAX_STYLE_BYTES} bytes` },
      { status: 400 },
    );
  }

  const preset: SharedPreset = {
    id: `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    label: body.label.trim().slice(0, MAX_LABEL_CHARS),
    style: body.style,
    createdAt: Date.now(),
  };

  const store = getSharedPresetStore();
  await store.add(preset);
  return NextResponse.json({ preset });
}

export async function DELETE(req: Request) {
  const key = clientKeyFromRequest(req);
  const limit = checkRateLimit(key);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Slow down.' },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil(limit.retryAfterMs / 1000)) },
      },
    );
  }

  const id = new URL(req.url).searchParams.get('id');
  if (!id) {
    return NextResponse.json({ error: 'id required' }, { status: 400 });
  }

  const store = getSharedPresetStore();
  const removed = await store.remove(id);
  if (!removed) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
