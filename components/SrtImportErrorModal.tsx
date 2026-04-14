'use client';

import { useEffect, useMemo, useState } from 'react';
import type { SubtitleDiagnostic } from '@/lib/subtitle-formats';

// Modal shown when an SRT/VTT import fails. Two halves:
//   1. Diagnostic — what we expected vs. what we found, in plain language.
//   2. Recovery   — the canonical SRT example + a copy-pastable AI prompt
//      the user can drop into ChatGPT/Claude/etc. to convert their broken
//      file. The original (broken) text is appended to the prompt so the
//      AI has something to work from.

const SRT_EXAMPLE = `1
00:00:01,000 --> 00:00:04,000
First subtitle line.
Optional second line.

2
00:00:05,500 --> 00:00:08,200
Next subtitle here.`;

function buildAiPrompt(originalText: string): string {
  return `Convert the subtitle text below into valid SRT format.

Required output rules (no exceptions):
- Each cue is exactly: a numeric index line, a timing line, one or more text lines, then a blank line.
- Indices start at 1 and increment by 1.
- Timing line format: HH:MM:SS,mmm --> HH:MM:SS,mmm
  (use a COMMA before the milliseconds, not a period; pad with leading zeros.)
- Use the literal arrow "-->" (two hyphens then a greater-than) — not unicode arrows or " to ".
- Preserve the original text and timing exactly. Do not translate or rephrase.
- No markdown fences, no JSON, no commentary, no header — just the SRT cues.

Subtitle source to convert:
"""
${originalText}
"""`;
}

function reasonHeadline(d: SubtitleDiagnostic): string {
  switch (d.likelyCause) {
    case 'empty-file':
      return 'The file is empty.';
    case 'no-timing-marker':
      return "We couldn't find any timing lines (the “00:00:00,000 --> 00:00:04,000” bits).";
    case 'unrecognized-time-format':
      return "We found timing lines, but couldn't parse the timestamps.";
    case 'looks-like-something-else':
      return "We couldn't recognize this as a subtitle file.";
    default:
      return "We couldn't read this file as subtitles.";
  }
}

type Props = {
  diagnostic: SubtitleDiagnostic;
  fileName: string;
  originalText: string;
  onClose: () => void;
};

export function SrtImportErrorModal({
  diagnostic,
  fileName,
  originalText,
  onClose,
}: Props) {
  const [copied, setCopied] = useState<'prompt' | 'example' | null>(null);
  const prompt = useMemo(() => buildAiPrompt(originalText), [originalText]);

  // Animate the backdrop blur in (same pattern as ExportModal).
  const [blurReady, setBlurReady] = useState(false);
  useEffect(() => {
    const id = window.requestAnimationFrame(() => setBlurReady(true));
    return () => window.cancelAnimationFrame(id);
  }, []);

  // ESC closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copy = async (text: string, which: 'prompt' | 'example') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      window.setTimeout(() => setCopied((c) => (c === which ? null : c)), 1500);
    } catch {
      // Clipboard may be blocked (insecure context, permissions). The
      // textareas are already selectable manually as fallback.
    }
  };

  const headline = reasonHeadline(diagnostic);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-4 transition-[backdrop-filter,background-color] duration-200 ease-out"
      style={{
        backgroundColor: blurReady ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0)',
        backdropFilter: blurReady ? 'blur(8px)' : 'blur(0px)',
        WebkitBackdropFilter: blurReady ? 'blur(8px)' : 'blur(0px)',
      }}
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-bg-elev shadow-2xl transition-all duration-200 ease-out"
        style={{
          opacity: blurReady ? 1 : 0,
          transform: blurReady ? 'scale(1)' : 'scale(0.97)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-text">
              Couldn&apos;t import subtitles
            </h2>
            <div className="text-[11px] text-text-muted">{fileName}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-text-muted hover:bg-bg-hi hover:text-text"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4 text-xs text-text">
          {/* What went wrong */}
          <div className="rounded-md border border-red-900/40 bg-red-900/10 p-3">
            <div className="font-semibold text-red-300">{headline}</div>
            <div className="mt-1.5 text-[11px] text-text-muted">
              Detected: {diagnostic.totalSections} section
              {diagnostic.totalSections === 1 ? '' : 's'} ·{' '}
              {diagnostic.validCues} valid cue
              {diagnostic.validCues === 1 ? '' : 's'}
              {diagnostic.sectionsMissingTimingLine > 0 &&
                ` · ${diagnostic.sectionsMissingTimingLine} missing timing line${
                  diagnostic.sectionsMissingTimingLine === 1 ? '' : 's'
                }`}
              {diagnostic.sectionsWithBadTiming > 0 &&
                ` · ${diagnostic.sectionsWithBadTiming} unparseable timestamp${
                  diagnostic.sectionsWithBadTiming === 1 ? '' : 's'
                }`}
              .
            </div>
            {diagnostic.firstBadSnippet && (
              <pre className="mt-2 max-h-24 overflow-auto rounded bg-bg/60 p-2 font-mono text-[10px] text-text-muted">
{diagnostic.firstBadSnippet}
              </pre>
            )}
          </div>

          {/* What a valid SRT looks like */}
          <div className="rounded-md border border-border bg-bg p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                Expected format (SRT)
              </span>
              <button
                type="button"
                onClick={() => void copy(SRT_EXAMPLE, 'example')}
                className="text-[10px] text-accent hover:underline"
              >
                {copied === 'example' ? 'Copied!' : 'Copy example'}
              </button>
            </div>
            <pre className="overflow-auto rounded bg-bg-elev/60 p-2 font-mono text-[11px] leading-relaxed text-text">
{SRT_EXAMPLE}
            </pre>
            <ul className="mt-2 space-y-1 text-[11px] text-text-muted">
              <li>· Numeric index, then timing, then text, blank line between cues.</li>
              <li>· Comma before milliseconds (<code>,000</code>, not <code>.000</code>).</li>
              <li>· Use the literal arrow <code>--&gt;</code>, not unicode arrows.</li>
              <li>· VTT files (<code>.vtt</code>) work too — drop them as-is.</li>
            </ul>
          </div>

          {/* AI prompt to recover the file */}
          <div className="rounded-md border border-border bg-bg p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                Or paste this into an AI to fix it
              </span>
              <button
                type="button"
                onClick={() => void copy(prompt, 'prompt')}
                className="rounded bg-accent px-2 py-0.5 text-[10px] font-semibold text-bg hover:bg-accent/90"
              >
                {copied === 'prompt' ? 'Copied!' : 'Copy prompt'}
              </button>
            </div>
            <textarea
              readOnly
              value={prompt}
              className="h-40 w-full resize-none rounded border border-border bg-bg-elev/60 p-2 font-mono text-[10px] leading-relaxed text-text-muted focus:border-accent focus:outline-none"
              onFocus={(e) => e.currentTarget.select()}
            />
            <div className="mt-1.5 text-[10px] text-text-muted">
              The prompt embeds your file&apos;s contents. Paste into ChatGPT,
              Claude, or any LLM, then save the response with a <code>.srt</code>{' '}
              extension and drop it back here.
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-text hover:border-border-hi hover:bg-bg-hi"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
