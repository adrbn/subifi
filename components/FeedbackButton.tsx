'use client';

import { useEffect, useState } from 'react';
import { useEditor } from '@/lib/store';
import { Button } from './ui/button';

// Floating "Report bug / Request feature" entry-point + modal.
//
// Mounted in the top header so it's always reachable. Clicking opens a small
// modal where the user picks a kind, types a message, and (optionally)
// leaves contact info. The submission goes to /api/feedback which logs it on
// the Vercel server side — no third-party integration to wire up.
//
// We attach a chunk of editor context (file name, duration, blocks/overlays
// counts, browser UA) so reports come with enough info to repro without us
// having to chase the user for it.

type Kind = 'bug' | 'feature' | 'other';

const KINDS: { value: Kind; label: string }[] = [
  { value: 'bug', label: '🐞 Bug' },
  { value: 'feature', label: '✨ Feature' },
  { value: 'other', label: '💬 Other' },
];

export function FeedbackButton() {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>('bug');
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  // Snapshot the bits of editor state that are useful for reproducing a
  // report — kept local so we don't subscribe to anything heavy.
  const {
    videoFile,
    videoDuration,
    videoWidth,
    videoHeight,
    blocks,
    textOverlays,
    overlays,
    cuts,
    style,
  } = useEditor();

  // Close on ESC. Only mounts the listener while the modal is open so we
  // don't intercept ESC for other things (like the editor's own shortcuts).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const reset = () => {
    setMessage('');
    setEmail('');
    setError(null);
    setSent(false);
    setKind('bug');
  };

  const onClose = () => {
    setOpen(false);
    // Defer the reset so the modal animates out cleanly without flickering
    // back to the empty state mid-fade.
    setTimeout(reset, 200);
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const trimmed = message.trim();
    if (trimmed.length === 0) {
      setError('Please describe what happened.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind,
          message: trimmed,
          email: email.trim() || undefined,
          context: {
            videoName: videoFile?.name,
            videoSize: videoFile?.size,
            videoDuration,
            videoWidth,
            videoHeight,
            blocksCount: blocks.length,
            textOverlaysCount: textOverlays.length,
            imageOverlaysCount: overlays.length,
            cutsCount: cuts.length,
            fontFamily: style.fontFamily,
            url: typeof window !== 'undefined' ? window.location.href : '',
            userAgent:
              typeof navigator !== 'undefined' ? navigator.userAgent : '',
          },
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(data?.error ?? `Server returned ${res.status}`);
      }
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 rounded-md border border-border bg-bg-hi px-2 py-1 text-xs text-text-muted transition-colors hover:border-accent hover:text-text"
        title="Report a bug or request a feature"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <span className="hidden sm:inline">Feedback</span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
          onClick={onClose}
        >
          <div
            className="w-full max-w-md rounded-lg border border-border bg-bg-elev p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-text">
                Send feedback
              </h2>
              <button
                type="button"
                onClick={onClose}
                className="rounded p-1 text-text-muted hover:bg-bg-hi hover:text-text"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            {sent ? (
              <div className="space-y-3 text-sm text-text">
                <p className="text-emerald-300">
                  Thanks! Your feedback was sent.
                </p>
                <p className="text-xs text-text-muted">
                  It&apos;ll show up in the Vercel project logs the next time
                  the dev checks them.
                </p>
                <Button onClick={onClose} variant="secondary" size="sm">
                  Close
                </Button>
              </div>
            ) : (
              <form onSubmit={onSubmit} className="space-y-3">
                <div className="flex gap-2">
                  {KINDS.map((k) => (
                    <button
                      key={k.value}
                      type="button"
                      onClick={() => setKind(k.value)}
                      className={`flex-1 rounded border px-2 py-1.5 text-xs transition-colors ${
                        kind === k.value
                          ? 'border-accent bg-accent/10 text-text'
                          : 'border-border bg-bg-hi text-text-muted hover:border-accent/50'
                      }`}
                    >
                      {k.label}
                    </button>
                  ))}
                </div>

                <label className="block">
                  <span className="text-xs text-text-muted">
                    What happened?
                  </span>
                  <textarea
                    autoFocus
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    rows={5}
                    maxLength={4000}
                    placeholder={
                      kind === 'bug'
                        ? 'Steps to reproduce, what you expected, what you got…'
                        : 'Describe what you want and why it would help…'
                    }
                    className="mt-1 w-full resize-none rounded border border-border bg-bg-hi px-2 py-1.5 text-sm text-text outline-none focus:border-accent"
                  />
                </label>

                <label className="block">
                  <span className="text-xs text-text-muted">
                    Email (optional, in case I need to ask follow-ups)
                  </span>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="mt-1 w-full rounded border border-border bg-bg-hi px-2 py-1.5 text-sm text-text outline-none focus:border-accent"
                  />
                </label>

                {error && (
                  <div className="rounded border border-red-900 bg-red-950/40 px-2 py-1.5 text-xs text-red-200">
                    {error}
                  </div>
                )}

                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={onClose}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    size="sm"
                    disabled={busy || message.trim().length === 0}
                  >
                    {busy ? 'Sending…' : 'Send'}
                  </Button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
