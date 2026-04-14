'use client';

import { useEffect, useRef, useState } from 'react';
import { useEditor } from '@/lib/store';
import { Button } from './ui/button';
import { TranscribeInlineButton } from './TranscribeButton';
import { GOOGLE_FONTS, loadGoogleFont } from '@/lib/google-fonts';
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
    style: globalStyle,
    updateBlock,
    mergeWithNext,
    deleteBlock,
    splitBlockAt,
    currentTime,
    status,
    progress,
    transcribeChunks,
    selectedBlockId,
    selectBlock,
  } = useEditor();
  // Track each row's textarea so the visible scissors button can read the
  // caret position — Shift+Enter inside the textarea has access to the event
  // target directly, but the button click happens outside the field.
  const textareaRefs = useRef<Record<string, HTMLTextAreaElement>>({});
  // Refs to each row's outer element so we can scroll one into view when
  // the timeline asks us to focus a specific block.
  const rowRefs = useRef<Record<string, HTMLDivElement>>({});
  // Currently flashed-block id (briefly highlighted after a focus event so
  // the user can see *which* row scrolled into view). Auto-clears after a
  // short delay.
  const [flashId, setFlashId] = useState<string | null>(null);

  // Listen for `subifi:focus-block` events dispatched by the Timeline. When
  // one arrives, scroll the matching row into view and flash it briefly.
  useEffect(() => {
    const onFocus = (e: Event) => {
      const id = (e as CustomEvent<{ id: string }>).detail?.id;
      if (!id) return;
      const el = rowRefs.current[id];
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setFlashId(id);
      // 1.4s is long enough for the user to see the flash but short enough
      // not to feel sticky after they start interacting with another row.
      window.setTimeout(() => {
        setFlashId((cur) => (cur === id ? null : cur));
      }, 1400);
    };
    window.addEventListener('subifi:focus-block', onFocus);
    return () => window.removeEventListener('subifi:focus-block', onFocus);
  }, []);
  // Which rows have their per-block style override panel expanded. Tracked
  // locally because it's pure UI state — no need to put it in the store.
  const [openOverrides, setOpenOverrides] = useState<Record<string, boolean>>(
    {},
  );

  const toggleOverride = (id: string) =>
    setOpenOverrides((prev) => ({ ...prev, [id]: !prev[id] }));

  if (blocks.length === 0) {
    let label = 'No subtitles yet — upload a video to start.';
    if (status === 'extracting')
      label = `Extracting audio… ${Math.round(progress * 100)}%`;
    else if (status === 'audio-ready')
      label = 'Audio extracted — click "Transcrire automatiquement par IA" above.';
    else if (status === 'transcribing')
      label = transcribeChunks && transcribeChunks.total > 1
        ? `Transcribing with Groq — chunk ${transcribeChunks.done + 1} of ${transcribeChunks.total}…`
        : 'Transcribing with Groq…';
    else if (status === 'error') label = 'Something went wrong — see the banner above.';
    else if (status === 'ready')
      label = 'Transcription returned no words. Try a different clip?';
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-4 text-center text-sm text-text-muted">
        <span>{label}</span>
        <TranscribeInlineButton />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-3 py-2">
      <div className="flex flex-col gap-1.5">
        {blocks.map((b, i) => {
          const isActive = currentTime >= b.start && currentTime <= b.end;
          const isFlash = flashId === b.id;
          const isSelected = selectedBlockId === b.id;
          return (
            <div
              key={b.id}
              ref={(el) => {
                if (el) rowRefs.current[b.id] = el;
              }}
              onClick={() => selectBlock(b.id)}
              className={clsx(
                'cursor-pointer rounded-md border border-border bg-bg-elev px-2 py-1.5 transition-colors',
                isActive && !isSelected && 'border-accent/60 bg-accent/5',
                // Selection wins over "active" so the user can clearly see
                // which entry is currently the focus target regardless of
                // the playhead position.
                isSelected && 'border-accent bg-accent/10 ring-1 ring-accent',
                isFlash && 'border-amber-400 ring-1 ring-amber-400/60',
              )}
            >
              <div className="flex flex-col gap-1">
                <textarea
                  ref={(el) => {
                    if (el) textareaRefs.current[b.id] = el;
                  }}
                  value={b.text}
                  onChange={(e) => updateBlock(b.id, { text: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && e.shiftKey) {
                      e.preventDefault();
                      const ta = e.currentTarget;
                      const pos = ta.selectionStart;
                      const splitPos =
                        pos > 0 && pos < b.text.length
                          ? pos
                          : Math.floor(b.text.length / 2);
                      if (splitPos > 0 && splitPos < b.text.length) {
                        splitBlockAt(b.id, splitPos);
                      }
                    }
                  }}
                  rows={Math.max(1, b.text.split('\n').length)}
                  className="w-full resize-none rounded bg-transparent px-1 py-0.5 text-sm font-semibold text-text outline-none focus:bg-bg-hi"
                  title="Shift+Enter: split at cursor"
                />
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
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
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        const ta = textareaRefs.current[b.id];
                        const pos = ta?.selectionStart ?? 0;
                        // If the caret is inside the text, split there.
                        // Otherwise (mobile tap, caret at 0), split at
                        // the midpoint so the button always works.
                        const splitPos =
                          pos > 0 && pos < b.text.length
                            ? pos
                            : Math.floor(b.text.length / 2);
                        if (splitPos > 0 && splitPos < b.text.length) {
                          splitBlockAt(b.id, splitPos);
                        }
                      }}
                      title="Split subtitle in two"
                    >
                      ✂
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => toggleOverride(b.id)}
                      title="Override style for this subtitle only"
                      className={clsx(
                        b.styleOverride &&
                          Object.keys(b.styleOverride).length > 0 &&
                          'text-accent',
                      )}
                    >
                      🎨
                    </Button>
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
                      title="Delete this subtitle entry"
                      className="text-text-muted hover:bg-red-950/40 hover:text-red-300"
                    >
                      ✕
                    </Button>
                  </div>
                </div>
                {openOverrides[b.id] && (
                  <div className="mt-1 flex flex-wrap items-center gap-3 rounded border border-border bg-bg-hi/40 px-2 py-1.5 text-xs text-text-muted">
                    <label className="flex items-center gap-1">
                      <span>font</span>
                      <select
                        value={b.styleOverride?.fontFamily ?? globalStyle.fontFamily}
                        onChange={(e) => {
                          const family = e.target.value;
                          if (GOOGLE_FONTS.includes(family)) loadGoogleFont(family, b.styleOverride?.fontWeight ?? globalStyle.fontWeight);
                          updateBlock(b.id, { styleOverride: { ...b.styleOverride, fontFamily: family } });
                        }}
                        className="max-w-[120px] rounded bg-bg-hi px-1 py-0.5 text-text"
                      >
                        {GOOGLE_FONTS.map((f) => (
                          <option key={f} value={f}>{f}</option>
                        ))}
                      </select>
                    </label>
                    <label className="flex items-center gap-1">
                      <span>size</span>
                      <input
                        type="number" step={1} min={8} max={300}
                        value={b.styleOverride?.fontSize ?? globalStyle.fontSize}
                        onChange={(e) => updateBlock(b.id, { styleOverride: { ...b.styleOverride, fontSize: Number(e.target.value) } })}
                        className="w-14 rounded bg-bg-hi px-1 py-0.5 font-mono text-text"
                      />
                    </label>
                    <label className="flex items-center gap-1">
                      <span>weight</span>
                      <input
                        type="number" step={100} min={100} max={900}
                        value={b.styleOverride?.fontWeight ?? globalStyle.fontWeight}
                        onChange={(e) => updateBlock(b.id, { styleOverride: { ...b.styleOverride, fontWeight: Number(e.target.value) } })}
                        className="w-14 rounded bg-bg-hi px-1 py-0.5 font-mono text-text"
                      />
                    </label>
                    <label className="flex items-center gap-1">
                      <span>color</span>
                      <input
                        type="color"
                        value={b.styleOverride?.textColor ?? globalStyle.textColor}
                        onChange={(e) => updateBlock(b.id, { styleOverride: { ...b.styleOverride, textColor: e.target.value } })}
                      />
                    </label>
                    <label className="flex items-center gap-1">
                      <span>outline</span>
                      <input
                        type="color"
                        value={b.styleOverride?.textOutlineColor ?? globalStyle.textOutlineColor}
                        onChange={(e) => updateBlock(b.id, { styleOverride: { ...b.styleOverride, textOutlineColor: e.target.value } })}
                      />
                    </label>
                    <label className="flex items-center gap-1">
                      <span>outline W</span>
                      <input
                        type="number" step={0.5} min={0} max={20}
                        value={b.styleOverride?.textOutlineWidth ?? globalStyle.textOutlineWidth}
                        onChange={(e) => updateBlock(b.id, { styleOverride: { ...b.styleOverride, textOutlineWidth: Number(e.target.value) } })}
                        className="w-14 rounded bg-bg-hi px-1 py-0.5 font-mono text-text"
                      />
                    </label>
                    <label className="flex items-center gap-1">
                      <span>bg</span>
                      <input
                        type="color"
                        value={b.styleOverride?.backgroundColor ?? globalStyle.backgroundColor}
                        onChange={(e) => updateBlock(b.id, { styleOverride: { ...b.styleOverride, backgroundColor: e.target.value } })}
                      />
                    </label>
                    <label className="flex items-center gap-1">
                      <span>bg %</span>
                      <input
                        type="number" step={5} min={0} max={100}
                        value={Math.round((b.styleOverride?.backgroundOpacity ?? globalStyle.backgroundOpacity) * 100)}
                        onChange={(e) => updateBlock(b.id, { styleOverride: { ...b.styleOverride, backgroundOpacity: Number(e.target.value) / 100 } })}
                        className="w-14 rounded bg-bg-hi px-1 py-0.5 font-mono text-text"
                      />
                    </label>
                    <label className="flex items-center gap-1">
                      <span>Y%</span>
                      <input
                        type="number" step={1} min={0} max={100}
                        value={Math.round((b.styleOverride?.positionY ?? globalStyle.positionY) * 100)}
                        onChange={(e) => updateBlock(b.id, { styleOverride: { ...b.styleOverride, positionY: Number(e.target.value) / 100 } })}
                        className="w-14 rounded bg-bg-hi px-1 py-0.5 font-mono text-text"
                      />
                    </label>
                    <label className="flex items-center gap-1">
                      <span>width%</span>
                      <input
                        type="number" step={5} min={10} max={100}
                        value={Math.round((b.styleOverride?.maxWidth ?? globalStyle.maxWidth) * 100)}
                        onChange={(e) => updateBlock(b.id, { styleOverride: { ...b.styleOverride, maxWidth: Number(e.target.value) / 100 } })}
                        className="w-14 rounded bg-bg-hi px-1 py-0.5 font-mono text-text"
                      />
                    </label>
                    <label className="flex items-center gap-1">
                      <span>spacing</span>
                      <input
                        type="number" step={0.5} min={-10} max={30}
                        value={b.styleOverride?.letterSpacing ?? globalStyle.letterSpacing}
                        onChange={(e) => updateBlock(b.id, { styleOverride: { ...b.styleOverride, letterSpacing: Number(e.target.value) } })}
                        className="w-14 rounded bg-bg-hi px-1 py-0.5 font-mono text-text"
                      />
                    </label>
                    {b.styleOverride &&
                      Object.keys(b.styleOverride).length > 0 && (
                        <button
                          type="button"
                          onClick={() =>
                            updateBlock(b.id, { styleOverride: undefined })
                          }
                          className="ml-auto rounded border border-border px-2 py-0.5 text-text-muted hover:border-accent hover:text-text"
                          title="Reset this block to the global style"
                        >
                          reset
                        </button>
                      )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
