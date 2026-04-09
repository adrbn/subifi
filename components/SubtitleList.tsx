'use client';

import { useEditor } from '@/lib/store';
import { Button } from './ui/button';
import clsx from 'clsx';

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

function scrubTo(seconds: number) {
  const v = (window as unknown as { __previewVideo?: HTMLVideoElement }).__previewVideo;
  if (v) {
    v.currentTime = seconds;
    void v.play().catch(() => undefined);
  }
}

export function SubtitleList() {
  const {
    blocks,
    updateBlock,
    mergeWithNext,
    deleteBlock,
    splitBlockAt,
    currentTime,
    status,
    progress,
  } = useEditor();

  if (blocks.length === 0) {
    let label = 'No subtitles yet — upload a video to start.';
    if (status === 'extracting')
      label = `Extracting audio… ${Math.round(progress * 100)}%`;
    else if (status === 'audio-ready')
      label = 'Audio extracted — click "Transcrire automatiquement par IA" above.';
    else if (status === 'transcribing') label = 'Transcribing with Groq…';
    else if (status === 'error') label = 'Something went wrong — see the banner above.';
    else if (status === 'ready')
      label = 'Transcription returned no words. Try a different clip?';
    return (
      <div className="flex h-full w-full items-center justify-center text-sm text-text-muted">
        {label}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-3 py-2">
      <div className="flex flex-col gap-1.5">
        {blocks.map((b, i) => {
          const isActive = currentTime >= b.start && currentTime <= b.end;
          return (
            <div
              key={b.id}
              className={clsx(
                'flex items-start gap-2 rounded-md border border-border bg-bg-elev px-2 py-2 transition-colors',
                isActive && 'border-accent bg-accent/5',
              )}
            >
              <button
                className="shrink-0 rounded bg-bg-hi px-2 py-1 text-xs font-mono text-text-muted hover:bg-border"
                onClick={() => scrubTo(b.start)}
                title="Jump to this subtitle"
              >
                {fmt(b.start)}
              </button>
              <div className="flex flex-1 flex-col gap-1">
                <textarea
                  value={b.text}
                  onChange={(e) => updateBlock(b.id, { text: e.target.value })}
                  onKeyDown={(e) => {
                    // Shift+Enter: split the block at the caret position,
                    // like Capcut. Everything after the caret moves to a
                    // new block starting at the closest word timing.
                    if (e.key === 'Enter' && e.shiftKey) {
                      e.preventDefault();
                      const ta = e.currentTarget;
                      const pos = ta.selectionStart;
                      if (pos > 0 && pos < b.text.length) {
                        splitBlockAt(b.id, pos);
                      }
                    }
                  }}
                  rows={Math.max(1, b.text.split('\n').length)}
                  className="w-full resize-none rounded bg-transparent px-1 py-0.5 text-sm text-text outline-none focus:bg-bg-hi"
                  title="Shift+Enter: split at cursor"
                />
                <div className="flex items-center gap-2 text-xs text-text-muted">
                  <label className="flex items-center gap-1">
                    <span>start</span>
                    <input
                      type="number"
                      step={0.05}
                      value={b.start.toFixed(2)}
                      onChange={(e) =>
                        updateBlock(b.id, { start: Number(e.target.value) })
                      }
                      className="w-16 rounded bg-bg-hi px-1 py-0.5 font-mono text-text"
                    />
                  </label>
                  <label className="flex items-center gap-1">
                    <span>end</span>
                    <input
                      type="number"
                      step={0.05}
                      value={b.end.toFixed(2)}
                      onChange={(e) =>
                        updateBlock(b.id, { end: Number(e.target.value) })
                      }
                      className="w-16 rounded bg-bg-hi px-1 py-0.5 font-mono text-text"
                    />
                  </label>
                  <div className="ml-auto flex gap-1">
                    {i < blocks.length - 1 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => mergeWithNext(b.id)}
                        title="Merge with next"
                      >
                        ⇓
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => deleteBlock(b.id)}
                      title="Delete"
                    >
                      ✕
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
