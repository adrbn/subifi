import { NextResponse } from 'next/server';
import { checkRateLimit, clientKeyFromRequest } from '@/lib/rate-limit';

// Receives bug reports / feature requests submitted from the in-app modal.
//
// Storage strategy: just console.log to the server. On Vercel that puts the
// payload into the project's runtime logs (Project → Logs in the dashboard),
// which is exactly where the user wants to read these — no DB, no email
// integration to maintain. The shape is intentionally minimal so we can
// later swap the backing store (e.g. Linear, Slack webhook) without changing
// the client.

export const runtime = 'nodejs';
export const maxDuration = 10;

type FeedbackKind = 'bug' | 'feature' | 'other';

type FeedbackRequest = {
  kind: FeedbackKind;
  message: string;
  email?: string;
  // Free-form context the client can attach so we can repro: video filename,
  // duration, blocks count, browser UA, etc. Cap on the server.
  context?: Record<string, unknown>;
};

const KINDS: FeedbackKind[] = ['bug', 'feature', 'other'];
const MAX_MESSAGE_CHARS = 4000;
const MAX_EMAIL_CHARS = 200;
const MAX_CONTEXT_CHARS = 4000;

function sanitizeKind(value: unknown): FeedbackKind {
  return typeof value === 'string' && KINDS.includes(value as FeedbackKind)
    ? (value as FeedbackKind)
    : 'other';
}

export async function POST(req: Request) {
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

  let body: FeedbackRequest;
  try {
    body = (await req.json()) as FeedbackRequest;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body || typeof body.message !== 'string') {
    return NextResponse.json(
      { error: 'message is required' },
      { status: 400 },
    );
  }

  const message = body.message.trim();
  if (message.length === 0) {
    return NextResponse.json(
      { error: 'message must not be empty' },
      { status: 400 },
    );
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return NextResponse.json(
      { error: `message exceeds ${MAX_MESSAGE_CHARS} chars` },
      { status: 413 },
    );
  }

  const email =
    typeof body.email === 'string' && body.email.length <= MAX_EMAIL_CHARS
      ? body.email.trim()
      : undefined;

  // Stringify context with a hard cap so a giant blob can't blow up the log
  // pipeline. We do the cap on the serialized form because that's what
  // actually gets stored.
  let contextStr = '';
  if (body.context && typeof body.context === 'object') {
    try {
      contextStr = JSON.stringify(body.context);
      if (contextStr.length > MAX_CONTEXT_CHARS) {
        contextStr = `${contextStr.slice(0, MAX_CONTEXT_CHARS)}…[truncated]`;
      }
    } catch {
      contextStr = '[unserializable context]';
    }
  }

  const kind = sanitizeKind(body.kind);
  const ua = req.headers.get('user-agent') ?? 'unknown';

  // The structured prefix makes it grep-friendly in Vercel logs:
  //   `vc logs --filter '[FEEDBACK]'`
  // eslint-disable-next-line no-console
  console.log('[FEEDBACK]', {
    kind,
    message,
    email,
    context: contextStr,
    ip: key,
    ua,
    receivedAt: new Date().toISOString(),
  });

  return NextResponse.json({ ok: true });
}
