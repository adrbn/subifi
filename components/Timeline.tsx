'use client';

import { useEditor } from '@/lib/store';

// Lightweight timeline: a horizontal bar showing the video duration, with
// one marker per subtitle block. Clicking anywhere scrubs the video, and
// scrolling the wheel anywhere over the timeline resizes the global
// subtitle font size — same mental model as wheel-to-zoom on the subtitle
// text inside the preview, just surfaced on the timeline so the user can
// adjust text size without aiming at the tiny subtitle box.

export function Timeline() {
  const { blocks, videoDuration, currentTime, style, setStyle } = useEditor();

  if (!videoDuration) {
    return (
      <div className="flex h-14 w-full items-center justify-center rounded-md border border-border bg-bg-elev text-xs text-text-muted">
        Timeline
      </div>
    );
  }

  const scrub = (pct: number) => {
    const v = (window as unknown as { __previewVideo?: HTMLVideoElement }).__previewVideo;
    if (v) v.currentTime = pct * videoDuration;
  };

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    // Block the page scroll so the wheel lives entirely inside the timeline.
    e.preventDefault();
    e.stopPropagation();
    const step = e.deltaY > 0 ? -2 : 2;
    const next = Math.max(10, Math.min(240, style.fontSize + step));
    setStyle({ fontSize: next });
  };

  return (
    <div
      className="relative h-14 w-full select-none rounded-md border border-border bg-bg-elev"
      onClick={(e) => {
        const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
        const pct = (e.clientX - rect.left) / rect.width;
        scrub(Math.max(0, Math.min(1, pct)));
      }}
      onWheel={onWheel}
      title={`Click to scrub · wheel to resize text (${style.fontSize}px)`}
    >
      {/* subtitle blocks */}
      {blocks.map((b) => {
        const left = (b.start / videoDuration) * 100;
        const width = ((b.end - b.start) / videoDuration) * 100;
        return (
          <div
            key={b.id}
            className="absolute top-1.5 h-6 rounded bg-accent/70 hover:bg-accent"
            style={{ left: `${left}%`, width: `${width}%` }}
            title={b.text}
          />
        );
      })}
      {/* playhead */}
      <div
        className="pointer-events-none absolute top-0 h-full w-0.5 bg-white"
        style={{ left: `${(currentTime / videoDuration) * 100}%` }}
      />
      {/* duration label */}
      <div className="pointer-events-none absolute bottom-0 right-2 text-[10px] text-text-muted">
        {Math.floor(videoDuration / 60)}:{(videoDuration % 60).toFixed(0).padStart(2, '0')}
      </div>
    </div>
  );
}
