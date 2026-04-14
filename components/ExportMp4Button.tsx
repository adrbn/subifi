'use client';

import { useEditor } from '@/lib/store';

// Header CTA. Two roles:
//   1. Idle  → click opens the ExportModal where the user picks options
//      and triggers the actual burn.
//   2. Burning + modal closed → "Run in background" indicator. Pulses to
//      show work is ongoing; click re-opens the modal with live progress.
//
// All burn logic lives in ExportModal — this component is purely the
// header affordance.

export function ExportMp4Button() {
  const {
    videoFile,
    overlays,
    textOverlays,
    blocks,
    status,
    progress,
    exportModalOpen,
    setExportModalOpen,
  } = useEditor();

  const hasAnyContent =
    blocks.length > 0 || overlays.length > 0 || textOverlays.length > 0;
  const isBurning = status === 'burning';
  const disabled = !videoFile || (!hasAnyContent && !isBurning);

  const onClick = () => {
    setExportModalOpen(true);
  };

  // Burning AND modal closed → background-progress pill that pulses.
  if (isBurning && !exportModalOpen) {
    const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100);
    return (
      <button
        type="button"
        data-tour="export"
        onClick={onClick}
        // animate-pulse on the dot + a flowing gradient on the bg gives a
        // clear "live work in the background" signal without being noisy.
        className="group relative inline-flex items-center gap-2 overflow-hidden rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-emerald-500"
        title="Export running — click to open progress"
      >
        <span
          className="h-2 w-2 animate-pulse rounded-full bg-white"
          aria-hidden
        />
        <span>Exporting · {pct}%</span>
        {/* Flowing shimmer to reinforce "alive" state */}
        <span
          className="pointer-events-none absolute inset-y-0 -left-1/2 w-1/2 -skew-x-12 bg-gradient-to-r from-transparent via-white/25 to-transparent"
          style={{ animation: 'subifi-export-shimmer 1.6s linear infinite' }}
          aria-hidden
        />
      </button>
    );
  }

  return (
    <button
      type="button"
      data-tour="export"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-emerald-900/60 disabled:text-emerald-300/50"
      title={
        disabled
          ? 'Add subtitles, text, or images first'
          : 'Open export options'
      }
    >
      <span>▶</span>
      <span>Export</span>
    </button>
  );
}
