'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from '@/lib/store';
import { burnSubtitles, cancelBurn, BurnCancelledError } from '@/lib/burn-in';
import { downloadBlob } from '@/lib/download';
import type { Cut } from '@/lib/types';

// Modal controlling the MP4 burn pipeline.
//
// Two visual states share the same shell:
//   - Idle (status !== 'burning'): export-options form + a primary "Start
//     export" CTA. Includes an optional range picker that scopes the export
//     to a sub-portion of the source video.
//   - Running (status === 'burning'): live progress bar + stage label +
//     elapsed time + Cancel button.
//
// The modal can be dismissed mid-export ("Run in background") — the burn
// keeps going and the header button starts pulsing. Re-clicking the button
// re-opens this modal with the live state.
//
// Range → cuts mapping
// --------------------
// The burn pipeline already supports `cuts` (segments to stitch out). A
// "custom range" is just two extra cuts added to whatever the user already
// authored: [0, rangeStart] at the head and [rangeEnd, videoDuration] at
// the tail. This avoids growing the BurnInput surface and keeps a single
// timeline-trim code path.

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

// Map raw progress fraction → human-readable stage string.
function progressStage(progress: number): string {
  if (progress <= 0.001) return 'Preparing…';
  if (progress < 0.05) return 'Loading ffmpeg core…';
  if (progress < 0.95) return 'Encoding video with subtitles…';
  if (progress < 1) return 'Finalizing MP4…';
  return 'Done';
}

// ---------------------------------------------------------------------------
// Range slider — two-handle picker on a track. Pure UI; emits start/end in
// seconds clamped to [0, duration] with start <= end - MIN_DUR.
// ---------------------------------------------------------------------------

const MIN_RANGE_SEC = 0.5;

type RangeSliderProps = {
  duration: number;
  start: number;
  end: number;
  onChange: (start: number, end: number) => void;
};

function RangeSlider({ duration, start, end, onChange }: RangeSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ which: 'start' | 'end' | null }>({ which: null });

  const startPct = duration > 0 ? (start / duration) * 100 : 0;
  const endPct = duration > 0 ? (end / duration) * 100 : 100;

  // Resolve a clientX into a clamped seconds value relative to the track.
  const xToSeconds = (clientX: number): number => {
    const el = trackRef.current;
    if (!el || duration <= 0) return 0;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return ratio * duration;
  };

  const onPointerDown =
    (which: 'start' | 'end') => (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      dragRef.current.which = which;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.which) return;
    const t = xToSeconds(e.clientX);
    if (dragRef.current.which === 'start') {
      onChange(Math.min(t, end - MIN_RANGE_SEC), end);
    } else {
      onChange(start, Math.max(t, start + MIN_RANGE_SEC));
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current.which) {
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // ignore — pointer capture may already be released
      }
      dragRef.current.which = null;
    }
  };

  return (
    <div className="select-none">
      {/* Track */}
      <div
        ref={trackRef}
        className="relative h-8 w-full rounded-md bg-bg"
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {/* Selected window */}
        <div
          className="absolute inset-y-0 rounded-md bg-emerald-600/30 ring-1 ring-emerald-500/60"
          style={{ left: `${startPct}%`, right: `${100 - endPct}%` }}
        />
        {/* Start handle */}
        <div
          role="slider"
          aria-label="Range start"
          aria-valuemin={0}
          aria-valuemax={duration}
          aria-valuenow={start}
          onPointerDown={onPointerDown('start')}
          className="absolute top-1/2 z-10 h-6 w-3 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-sm bg-emerald-400 shadow ring-1 ring-emerald-200"
          style={{ left: `${startPct}%` }}
        />
        {/* End handle */}
        <div
          role="slider"
          aria-label="Range end"
          aria-valuemin={0}
          aria-valuemax={duration}
          aria-valuenow={end}
          onPointerDown={onPointerDown('end')}
          className="absolute top-1/2 z-10 h-6 w-3 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-sm bg-emerald-400 shadow ring-1 ring-emerald-200"
          style={{ left: `${endPct}%` }}
        />
      </div>
      {/* Time readouts */}
      <div className="mt-1.5 flex items-center justify-between text-[11px] font-mono text-text-muted">
        <span>{formatTime(start)}</span>
        <span>
          Length {formatTime(Math.max(0, end - start))} of {formatTime(duration)}
        </span>
        <span>{formatTime(end)}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export function ExportModal() {
  const {
    videoFile,
    videoDuration,
    videoWidth,
    videoHeight,
    style,
    customFonts,
    overlays,
    imageOverlaysVisible,
    textOverlays,
    textOverlaysVisible,
    cuts,
    cutsVisible,
    setStatus,
    setProgress,
    status,
    progress,
    visibleBlocks,
    blocks,
    exportModalOpen,
    setExportModalOpen,
  } = useEditor();

  // Range picker state. `mode` = 'full' uses the entire video; 'custom'
  // adds bracketing cuts to scope the export.
  const [rangeMode, setRangeMode] = useState<'full' | 'custom'>('full');
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(videoDuration || 0);

  // "Include subtitles" toggle. When OFF the burn pipeline receives empty
  // blocks + textOverlays arrays, which skips ASS generation and the
  // `subtitles=` filter entirely — letting the user export a clean video
  // (useful for posting unsubtitled reference cuts, A/B comparisons, etc.).
  const [includeSubtitles, setIncludeSubtitles] = useState(true);

  // Re-seed the range when the video changes so handles always start at
  // [0, duration] for a new project.
  useEffect(() => {
    setRangeStart(0);
    setRangeEnd(videoDuration || 0);
    setRangeMode('full');
  }, [videoDuration, videoFile]);

  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState<number>(Date.now());
  useEffect(() => {
    if (status !== 'burning') return;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [status]);

  // ESC closes the modal (background-export if a burn is running).
  useEffect(() => {
    if (!exportModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExportModalOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [exportModalOpen, setExportModalOpen]);

  // Animate the backdrop blur in when the modal opens. We start at 0 and
  // ramp to the target on the next frame so the CSS transition kicks in.
  // Going straight to the target on first paint = no animation.
  const [blurReady, setBlurReady] = useState(false);
  useEffect(() => {
    if (!exportModalOpen) {
      setBlurReady(false);
      return;
    }
    const id = window.requestAnimationFrame(() => setBlurReady(true));
    return () => window.cancelAnimationFrame(id);
  }, [exportModalOpen]);

  const baseName = videoFile?.name.replace(/\.[^.]+$/, '') ?? 'video';
  // "Anything to burn" for the CTA gate. When the user explicitly opts out
  // of subtitles, a re-encoded video IS valid output — so skip the check.
  const hasAnyContent =
    !includeSubtitles ||
    blocks.length > 0 ||
    overlays.length > 0 ||
    textOverlays.length > 0;
  const isBurning = status === 'burning';

  // Compose the cut list that will actually be sent to the burn pipeline:
  // user cuts (if visible) plus the range-bracketing cuts when in custom
  // mode. The pipeline merges and sorts them internally.
  const effectiveCuts = useMemo<Cut[]>(() => {
    const list: Cut[] = cutsVisible ? [...cuts] : [];
    if (rangeMode === 'custom' && videoDuration > 0) {
      if (rangeStart > 0.05) {
        list.push({ id: '__range_head__', start: 0, end: rangeStart });
      }
      if (rangeEnd < videoDuration - 0.05) {
        list.push({ id: '__range_tail__', start: rangeEnd, end: videoDuration });
      }
    }
    return list;
  }, [cuts, cutsVisible, rangeMode, rangeStart, rangeEnd, videoDuration]);

  const burnInFlightRef = useRef(false);

  const startExport = async () => {
    if (!videoFile || burnInFlightRef.current) return;
    burnInFlightRef.current = true;
    setStartedAt(Date.now());
    setStatus('burning', null);
    setProgress(0);
    try {
      // When `includeSubtitles` is off we hand empty block + text-overlay
      // arrays to the burn pipeline. Image overlays are kept as-is —
      // they're a separate channel and disabling them has its own toggle
      // on the sidebar.
      const burnBlocks = includeSubtitles ? visibleBlocks() : [];
      const burnOverlays = imageOverlaysVisible ? overlays : [];
      const burnTextOverlays =
        includeSubtitles && textOverlaysVisible ? textOverlays : [];
      const out = await burnSubtitles(
        {
          videoFile,
          blocks: burnBlocks,
          style,
          videoWidth,
          videoHeight,
          customFonts,
          overlays: burnOverlays,
          textOverlays: burnTextOverlays,
          cuts: effectiveCuts,
          videoDuration,
        },
        (p) => setProgress(p),
      );
      const suffix =
        rangeMode === 'custom'
          ? '-clip'
          : includeSubtitles
            ? '-subbed'
            : '-clean';
      downloadBlob(out, `${baseName}${suffix}.mp4`, 'video/mp4');
      setStatus('ready', null);
      setExportModalOpen(false);
    } catch (e) {
      if (e instanceof BurnCancelledError) {
        setStatus('ready', null);
        setProgress(0);
        return;
      }
      setStatus('error', e instanceof Error ? e.message : 'Burn failed');
    } finally {
      burnInFlightRef.current = false;
      setStartedAt(null);
    }
  };

  if (!exportModalOpen) return null;

  const elapsedMs = startedAt ? now - startedAt : 0;
  const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100);
  const stage = progressStage(progress);
  const exportLengthSec =
    rangeMode === 'custom'
      ? Math.max(0, rangeEnd - rangeStart)
      : videoDuration;
  const totalCutLength =
    rangeMode === 'custom'
      ? videoDuration - exportLengthSec +
        (cutsVisible
          ? cuts.reduce((sum, c) => sum + Math.max(0, c.end - c.start), 0)
          : 0)
      : cutsVisible
        ? cuts.reduce((sum, c) => sum + Math.max(0, c.end - c.start), 0)
        : 0;

  return (
    <div
      // 200ms easing — short enough to feel responsive, long enough to
      // read as a deliberate transition rather than a jump cut.
      className="fixed inset-0 z-[70] flex items-center justify-center p-4 transition-[backdrop-filter,background-color] duration-200 ease-out"
      style={{
        backgroundColor: blurReady ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0)',
        backdropFilter: blurReady ? 'blur(8px)' : 'blur(0px)',
        WebkitBackdropFilter: blurReady ? 'blur(8px)' : 'blur(0px)',
      }}
      onClick={() => setExportModalOpen(false)}
    >
      <div
        className="w-full max-w-md rounded-xl border border-border bg-bg-elev shadow-2xl transition-all duration-200 ease-out"
        style={{
          opacity: blurReady ? 1 : 0,
          transform: blurReady ? 'scale(1)' : 'scale(0.97)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-text">
            {isBurning ? 'Exporting…' : 'Export to MP4'}
          </h2>
          <button
            type="button"
            onClick={() => setExportModalOpen(false)}
            className="rounded p-1 text-text-muted hover:bg-bg-hi hover:text-text"
            title={isBurning ? 'Run in background' : 'Close'}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="space-y-4 px-4 py-4">
          {!isBurning ? (
            <>
              {/* Range / portion selector */}
              <div className="space-y-2 rounded-md border border-border bg-bg p-3 text-xs text-text">
                <div className="flex items-center justify-between">
                  <span className="font-semibold uppercase tracking-wider text-text-muted">
                    Range
                  </span>
                  <div className="inline-flex overflow-hidden rounded-md border border-border">
                    <button
                      type="button"
                      onClick={() => setRangeMode('full')}
                      className={`px-2 py-0.5 text-[11px] ${
                        rangeMode === 'full'
                          ? 'bg-accent text-bg'
                          : 'text-text-muted hover:bg-bg-hi'
                      }`}
                    >
                      Whole
                    </button>
                    <button
                      type="button"
                      onClick={() => setRangeMode('custom')}
                      disabled={!videoDuration}
                      className={`px-2 py-0.5 text-[11px] ${
                        rangeMode === 'custom'
                          ? 'bg-accent text-bg'
                          : 'text-text-muted hover:bg-bg-hi'
                      } disabled:cursor-not-allowed disabled:opacity-40`}
                    >
                      Portion
                    </button>
                  </div>
                </div>

                {rangeMode === 'custom' && videoDuration > 0 && (
                  <RangeSlider
                    duration={videoDuration}
                    start={rangeStart}
                    end={rangeEnd}
                    onChange={(s, e) => {
                      setRangeStart(s);
                      setRangeEnd(e);
                    }}
                  />
                )}

                {rangeMode === 'full' && (
                  <div className="text-text-muted">
                    Exporting the entire video ({formatTime(videoDuration)}).
                  </div>
                )}
              </div>

              {/* Content toggles */}
              <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-bg p-3 text-xs text-text hover:border-border-hi">
                <input
                  type="checkbox"
                  checked={includeSubtitles}
                  onChange={(e) => setIncludeSubtitles(e.target.checked)}
                  className="mt-0.5 h-3.5 w-3.5 accent-emerald-500"
                />
                <span className="flex-1">
                  <span className="font-medium">Burn subtitles into video</span>
                  <span className="mt-0.5 block text-[11px] text-text-muted">
                    {includeSubtitles
                      ? 'Subtitle blocks and text overlays will be rendered into the MP4.'
                      : 'Subtitles and text overlays will be SKIPPED. Output is the clean video.'}
                  </span>
                </span>
              </label>

              {/* Output summary */}
              <div className="space-y-1 rounded-md border border-border bg-bg p-3 text-xs">
                <div className="font-semibold uppercase tracking-wider text-text-muted">
                  Output
                </div>
                <div className="flex items-center justify-between">
                  <span>Resolution</span>
                  <span className="text-text-muted">
                    {videoWidth}×{videoHeight}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Cuts</span>
                  <span className="text-text-muted">
                    {cutsVisible && cuts.length > 0
                      ? `${cuts.length} stitched out`
                      : 'None'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Estimated length</span>
                  <span className="text-text-muted">
                    {formatTime(Math.max(0, videoDuration - totalCutLength))}
                  </span>
                </div>
              </div>

              <button
                type="button"
                onClick={() => void startExport()}
                disabled={!videoFile || !hasAnyContent}
                className="w-full rounded-md bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-emerald-900/60 disabled:text-emerald-300/50"
              >
                {hasAnyContent
                  ? rangeMode === 'custom'
                    ? `Start export · ${formatTime(exportLengthSec)}`
                    : includeSubtitles
                      ? 'Start export'
                      : 'Export clean video'
                  : 'Add subtitles or overlays first'}
              </button>
            </>
          ) : (
            <>
              <div className="space-y-1 text-xs text-text">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{stage}</span>
                  <span className="font-mono text-text-muted">{pct}%</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-bg">
                  <div
                    className="h-full bg-emerald-500 transition-[width] duration-150 ease-out"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="flex items-center justify-between pt-1 text-[11px] text-text-muted">
                  <span>Elapsed {formatElapsed(elapsedMs)}</span>
                  <span>
                    {visibleBlocks().length} subs · {textOverlays.length} text · {overlays.length} img
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setExportModalOpen(false)}
                  className="flex-1 rounded-md border border-border px-3 py-2 text-xs text-text hover:border-border-hi hover:bg-bg-hi"
                >
                  Run in background
                </button>
                <button
                  type="button"
                  onClick={() => cancelBurn()}
                  className="flex-1 rounded-md bg-red-600 px-3 py-2 text-xs font-semibold text-white hover:bg-red-500"
                >
                  Cancel export
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
