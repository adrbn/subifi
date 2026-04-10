'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditor } from '@/lib/store';
import { computeWaveformPeaks, WAVEFORM_BUCKETS } from '@/lib/waveform';

// Mini-timeline with three lanes:
//
//   Lane 1 (top)    — auto-generated subtitle blocks. Drag the body to
//                     scrub. Drag either edge to trim that side. Wheel
//                     zooms the global subtitle font size.
//   Lane 2 (middle) — manual text overlays. Same gesture set. Body click
//                     selects the overlay (so the StylePanel can edit it).
//   Lane 3 (bottom) — image overlays (logos, stickers). Body drag changes
//                     the visible time range — position/size are still
//                     edited on the preview itself.
//
// Clicking the empty timeline area scrubs the video.

const HANDLE_PX = 6;
// Snap threshold in pixels — applied once per drag tick against neighbor
// edges and the playhead. Kept intentionally small (~5px) so the snap
// feels like a subtle "lock" and doesn't fight the user on free drags.
const SNAP_PX = 5;

// Apply snap-to-neighbor for a candidate time value. `candidates` is the
// list of "interesting" times on the timeline (neighbor edges, playhead);
// the returned time is the closest candidate if it's within `snapSec`,
// otherwise the original value — so the caller can drag freely outside of
// the magnetism radius.
function snapTime(value: number, candidates: number[], snapSec: number): number {
  let best = value;
  let bestDist = snapSec;
  for (const c of candidates) {
    const d = Math.abs(value - c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

// Human-readable time label for grid markers. mm:ss for long videos,
// leading zero seconds for short clips.
function fmtTick(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Pick a grid tick interval that yields ~6–10 labels across the whole
// video. We snap to a fixed list so the spacing never looks weird.
function pickTickInterval(duration: number): number {
  const target = duration / 8;
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const s of steps) if (s >= target) return s;
  return steps[steps.length - 1];
}

type DragKind = 'move' | 'trim-start' | 'trim-end';

type DragTarget =
  | { type: 'block'; id: string; kind: DragKind }
  | { type: 'text'; id: string; kind: DragKind }
  | { type: 'image'; id: string; kind: DragKind }
  | { type: 'cut'; id: string; kind: DragKind };

export function Timeline() {
  const {
    blocks,
    subtitleTracks,
    activeTrackId,
    setActiveTrack,
    toggleTrackVisibility,
    textOverlays,
    textOverlaysVisible,
    toggleTextOverlaysVisible,
    overlays,
    imageOverlaysVisible,
    toggleImageOverlaysVisible,
    videoDuration,
    currentTime,
    style,
    setStyle,
    updateBlock,
    updateTextOverlay,
    selectTextOverlay,
    selectedTextOverlayId,
    addTextOverlay,
    deleteBlock,
    removeTextOverlay,
    updateOverlay,
    selectOverlay,
    selectedOverlayId,
    removeOverlay,
    extractedAudio,
    cuts,
    cutsVisible,
    toggleCutsVisible,
    updateCut,
    removeCut,
    selectedBlockId,
    selectBlock,
    splitSelectedAtPlayhead,
  } = useEditor();
  const trackRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drag, setDrag] = useState<DragTarget | null>(null);
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  // Horizontal zoom multiplier: 1 = full duration fits the container,
  // 32 = track is 32× wider and you scroll to navigate. Stored locally
  // because it's a view-only preference — no need to persist across
  // sessions, and no other component reads it.
  const [zoom, setZoom] = useState(1);
  const ZOOM_MIN = 1;
  const ZOOM_MAX = 32;

  // Decode the extracted audio once whenever it changes. The decode is
  // async + cancellable so a fast-clicking user doesn't apply stale peaks
  // from a previous video.
  useEffect(() => {
    if (!extractedAudio) {
      setPeaks(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await computeWaveformPeaks(
          extractedAudio,
          WAVEFORM_BUCKETS,
        );
        if (!cancelled) setPeaks(result);
      } catch {
        if (!cancelled) setPeaks(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [extractedAudio]);

  // Repaint the waveform canvas whenever peaks or the container width
  // change. We draw at devicePixelRatio so it stays crisp on retina.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (cssW <= 0 || cssH <= 0) return;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    if (!peaks || peaks.length === 0) return;
    // Draw a centered waveform — top half mirror of the bottom. We use
    // 1px-wide bars and skip drawing zero-height ones.
    ctx.fillStyle = 'rgba(148, 163, 184, 0.45)'; // slate-400 @ 45%
    const mid = cssH / 2;
    const bucketCount = peaks.length;
    for (let x = 0; x < cssW; x++) {
      // Map this pixel to a peak bucket — nearest neighbor.
      const idx = Math.min(
        bucketCount - 1,
        Math.floor((x / cssW) * bucketCount),
      );
      const amp = peaks[idx];
      const h = Math.max(0.5, amp * (cssH * 0.9));
      ctx.fillRect(x, mid - h / 2, 1, h);
    }
  }, [peaks]);

  // Repaint when the container resizes too — without this, peaks stay
  // pinned to the original width and look stretched after a window resize.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      // Trigger the paint effect by setting peaks to a new reference.
      setPeaks((p) => (p ? new Float32Array(p) : p));
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  if (!videoDuration) {
    return (
      <div className="flex h-32 w-full items-center justify-center rounded-md border border-border bg-bg-elev text-xs text-text-muted">
        Timeline
      </div>
    );
  }

  const scrub = (pct: number) => {
    const v = (window as unknown as { __previewVideo?: HTMLVideoElement })
      .__previewVideo;
    if (v) v.currentTime = pct * videoDuration;
  };

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    // Cmd/Ctrl + wheel → horizontal zoom centered on the cursor.
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      const scrollEl = scrollRef.current;
      const trackEl = trackRef.current;
      if (!scrollEl || !trackEl) return;
      // Zoom around the cursor so the time under the mouse stays fixed.
      const rect = trackEl.getBoundingClientRect();
      const cursorPx = e.clientX - rect.left; // in track pixels
      const pct = rect.width > 0 ? cursorPx / rect.width : 0;
      const factor = e.deltaY > 0 ? 0.85 : 1.18;
      setZoom((z) => {
        const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z * factor));
        // After the state commits the track gets a new width, but we can
        // pre-compute the target scroll position now because scrollLeft is
        // in container pixels, not track pixels. We read the new track
        // width from the ratio (next / z) on the current rect.
        const newTrackWidth = (rect.width * next) / z;
        const cursorPxAfter = pct * newTrackWidth;
        const cursorInContainer =
          e.clientX - scrollEl.getBoundingClientRect().left;
        const targetScrollLeft = cursorPxAfter - cursorInContainer;
        // Defer the scroll set so it runs after React has applied the new
        // width — otherwise we'd be scrolling inside the old viewport.
        requestAnimationFrame(() => {
          scrollEl.scrollLeft = Math.max(0, targetScrollLeft);
        });
        return next;
      });
      return;
    }
    // Shift + wheel → the legacy font-size tweak (kept as a power-user
    // shortcut now that the StylePanel has a dedicated slider).
    if (e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      const step = e.deltaY > 0 ? -2 : 2;
      const next = Math.max(10, Math.min(240, style.fontSize + step));
      setStyle({ fontSize: next });
      return;
    }
    // Plain wheel when zoomed → horizontal scroll. The scroll container
    // handles this natively, but trackpads often fire deltaY for up/down
    // flicks that users still expect to translate into horizontal travel.
    if (zoom > 1 && scrollRef.current) {
      const dominant =
        Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (dominant !== 0) {
        e.preventDefault();
        e.stopPropagation();
        scrollRef.current.scrollLeft += dominant;
      }
    }
  };

  // Auto-follow the playhead when zoomed so it never drifts off-screen
  // during playback. We keep it inside a 20%-edge comfort margin so the
  // scroll only jumps when the user can actually no longer see it.
  useEffect(() => {
    if (zoom <= 1) return;
    const scrollEl = scrollRef.current;
    const trackEl = trackRef.current;
    if (!scrollEl || !trackEl || !videoDuration) return;
    const trackWidth = trackEl.clientWidth;
    const playheadPx = (currentTime / videoDuration) * trackWidth;
    const viewLeft = scrollEl.scrollLeft;
    const viewRight = viewLeft + scrollEl.clientWidth;
    const margin = scrollEl.clientWidth * 0.2;
    if (playheadPx < viewLeft + margin || playheadPx > viewRight - margin) {
      scrollEl.scrollLeft = Math.max(
        0,
        playheadPx - scrollEl.clientWidth / 2,
      );
    }
  }, [currentTime, zoom, videoDuration]);

  const zoomIn = () => setZoom((z) => Math.min(ZOOM_MAX, z * 2));
  const zoomOut = () => setZoom((z) => Math.max(ZOOM_MIN, z / 2));
  const zoomReset = () => setZoom(1);

  // Generic drag handler — we resolve the right update path inside `move`
  // based on `target`, so trim handles and body drag share the same code.
  const onDragStart = useCallback(
    (target: DragTarget) =>
      (e: React.PointerEvent<HTMLDivElement>) => {
        if (!trackRef.current) return;
        e.preventDefault();
        e.stopPropagation();
        setDrag(target);
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        const rect = trackRef.current.getBoundingClientRect();
        const startX = e.clientX;

        // Snapshot the original block / overlay so move() can compute the
        // new value relative to the original — this avoids the cumulative
        // rounding error you get when each move() reads the just-updated
        // state from the store.
        let origStart = 0;
        let origEnd = 0;
        if (target.type === 'block') {
          const b = blocks.find((x) => x.id === target.id);
          if (!b) return;
          origStart = b.start;
          origEnd = b.end;
        } else if (target.type === 'text') {
          const o = textOverlays.find((x) => x.id === target.id);
          if (!o) return;
          origStart = o.start;
          origEnd = o.end;
          selectTextOverlay(o.id);
        } else if (target.type === 'image') {
          const o = overlays.find((x) => x.id === target.id);
          if (!o) return;
          origStart = o.start;
          origEnd = o.end;
          selectOverlay(o.id);
        } else {
          // cut
          const c = cuts.find((x) => x.id === target.id);
          if (!c) return;
          origStart = c.start;
          origEnd = c.end;
        }
        const origDuration = origEnd - origStart;

        // Snap candidates = every neighbor clip edge across both lanes +
        // the current playhead. We exclude the dragged item's own edges so
        // it doesn't lock to itself. Converting SNAP_PX to seconds keeps
        // the magnetism radius consistent regardless of timeline width.
        const snapSec = (SNAP_PX / Math.max(1, rect.width)) * videoDuration;
        const candidates: number[] = [];
        for (const b of blocks) {
          if (target.type === 'block' && b.id === target.id) continue;
          candidates.push(b.start, b.end);
        }
        for (const o of textOverlays) {
          if (target.type === 'text' && o.id === target.id) continue;
          candidates.push(o.start, o.end);
        }
        for (const o of overlays) {
          if (target.type === 'image' && o.id === target.id) continue;
          candidates.push(o.start, o.end);
        }
        for (const c of cuts) {
          if (target.type === 'cut' && c.id === target.id) continue;
          candidates.push(c.start, c.end);
        }
        candidates.push(currentTime);
        candidates.push(0, videoDuration);

        const move = (ev: PointerEvent) => {
          const deltaPx = ev.clientX - startX;
          const deltaSec = (deltaPx / rect.width) * videoDuration;
          let nextStart = origStart;
          let nextEnd = origEnd;
          if (target.kind === 'trim-start') {
            nextStart = Math.max(
              0,
              Math.min(origEnd - 0.05, origStart + deltaSec),
            );
            nextStart = snapTime(nextStart, candidates, snapSec);
            // Re-clamp after snap so a candidate past origEnd-0.05 doesn't
            // invert the clip.
            nextStart = Math.min(origEnd - 0.05, nextStart);
          } else if (target.kind === 'trim-end') {
            nextEnd = Math.max(
              origStart + 0.05,
              Math.min(videoDuration, origEnd + deltaSec),
            );
            nextEnd = snapTime(nextEnd, candidates, snapSec);
            nextEnd = Math.max(origStart + 0.05, nextEnd);
          } else {
            // Body drag — move the whole clip, clamp to [0, duration]
            nextStart = Math.max(
              0,
              Math.min(videoDuration - origDuration, origStart + deltaSec),
            );
            // Prefer snapping the leading edge (start). If that doesn't
            // lock, try the trailing edge so a clip butting up against a
            // neighbor on the right also snaps cleanly.
            const snappedStart = snapTime(nextStart, candidates, snapSec);
            if (snappedStart !== nextStart) {
              nextStart = snappedStart;
            } else {
              const candidateEnd = nextStart + origDuration;
              const snappedEnd = snapTime(candidateEnd, candidates, snapSec);
              if (snappedEnd !== candidateEnd) {
                nextStart = Math.max(
                  0,
                  Math.min(videoDuration - origDuration, snappedEnd - origDuration),
                );
              }
            }
            nextEnd = nextStart + origDuration;
          }
          if (target.type === 'block') {
            updateBlock(target.id, { start: nextStart, end: nextEnd });
          } else if (target.type === 'text') {
            updateTextOverlay(target.id, { start: nextStart, end: nextEnd });
          } else if (target.type === 'image') {
            updateOverlay(target.id, { start: nextStart, end: nextEnd });
          } else {
            updateCut(target.id, { start: nextStart, end: nextEnd });
          }
        };
        const up = () => {
          setDrag(null);
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      },
    [
      blocks,
      textOverlays,
      overlays,
      cuts,
      videoDuration,
      currentTime,
      updateBlock,
      updateTextOverlay,
      updateOverlay,
      updateCut,
      selectTextOverlay,
      selectOverlay,
    ],
  );

  // Click-to-scrub on empty area only — body/handle drags own the click.
  const onTrackClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (drag) return;
    if (e.target !== e.currentTarget) return;
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    scrub(Math.max(0, Math.min(1, pct)));
  };

  const onAddText = () => {
    const id = addTextOverlay();
    selectTextOverlay(id);
  };

  const hasSelection =
    !!selectedBlockId || !!selectedTextOverlayId || !!selectedOverlayId;

  return (
    <div data-tour="timeline" className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-text-muted">
        <span>Timeline</span>
        <div className="flex items-center gap-1.5">
          {/* Zoom controls — kept compact next to the existing actions.
              Cmd/Ctrl + wheel on the track does the same job for power users. */}
          <div className="flex items-center overflow-hidden rounded border border-border bg-bg-hi">
            <button
              type="button"
              onClick={zoomOut}
              disabled={zoom <= ZOOM_MIN}
              className="px-1.5 py-0.5 text-text-muted hover:text-text disabled:opacity-30"
              title="Zoom out (Cmd/Ctrl + wheel)"
            >
              −
            </button>
            <button
              type="button"
              onClick={zoomReset}
              className="border-x border-border px-1.5 py-0.5 font-mono text-text-muted hover:text-text"
              title="Reset zoom"
            >
              {zoom < 1.05 ? '1×' : `${zoom.toFixed(zoom < 10 ? 1 : 0)}×`}
            </button>
            <button
              type="button"
              onClick={zoomIn}
              disabled={zoom >= ZOOM_MAX}
              className="px-1.5 py-0.5 text-text-muted hover:text-text disabled:opacity-30"
              title="Zoom in (Cmd/Ctrl + wheel)"
            >
              +
            </button>
          </div>
          <button
            type="button"
            onClick={onAddText}
            className="rounded border border-border bg-bg-hi px-2 py-0.5 text-text-muted hover:border-accent hover:text-text"
            title="Add a manual text overlay at the current time"
          >
            + Texte
          </button>
          <button
            type="button"
            onClick={splitSelectedAtPlayhead}
            disabled={!hasSelection}
            className="rounded border border-border bg-bg-hi px-2 py-0.5 text-text-muted hover:border-accent hover:text-text disabled:opacity-30 disabled:cursor-not-allowed"
            title={
              hasSelection
                ? 'Split selected element at the playhead position'
                : 'Select an element on the timeline first'
            }
          >
            ✂ Couper
          </button>
        </div>
      </div>
      {/* Eye toggles + lane labels — sits to the left of the scroll area */}
      <div className="flex gap-0">
      <div className="flex flex-col gap-0 pt-0 shrink-0 w-20 border-r border-border bg-bg-elev rounded-l-md text-[9px]">
        {subtitleTracks.map((track) => (
          <div
            key={track.id}
            className={`flex items-center gap-0.5 h-[30px] px-1 cursor-pointer border-b border-border/40 ${
              track.id === activeTrackId ? 'bg-accent/10' : ''
            }`}
            onClick={() => setActiveTrack(track.id)}
          >
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); toggleTrackVisibility(track.id); }}
              className={`shrink-0 text-[11px] ${track.visible ? 'text-text' : 'text-text-muted/40'}`}
              title={track.visible ? 'Hide track' : 'Show track'}
            >
              {track.visible ? '👁' : '👁‍🗨'}
            </button>
            <span className="truncate text-text-muted">{track.label}</span>
          </div>
        ))}
        <div className="flex items-center gap-0.5 h-[30px] px-1 border-b border-border/40">
          <button
            type="button"
            onClick={toggleTextOverlaysVisible}
            className={`shrink-0 text-[11px] ${textOverlaysVisible ? 'text-text' : 'text-text-muted/40'}`}
            title={textOverlaysVisible ? 'Hide text overlays' : 'Show text overlays'}
          >
            {textOverlaysVisible ? '👁' : '👁‍🗨'}
          </button>
          <span className="truncate text-text-muted">Textes</span>
        </div>
        <div className="flex items-center gap-0.5 h-[30px] px-1 border-b border-border/40">
          <button
            type="button"
            onClick={toggleImageOverlaysVisible}
            className={`shrink-0 text-[11px] ${imageOverlaysVisible ? 'text-text' : 'text-text-muted/40'}`}
            title={imageOverlaysVisible ? 'Hide images' : 'Show images'}
          >
            {imageOverlaysVisible ? '👁' : '👁‍🗨'}
          </button>
          <span className="truncate text-text-muted">Images</span>
        </div>
        <div className="flex items-center gap-0.5 h-[30px] px-1">
          <button
            type="button"
            onClick={toggleCutsVisible}
            className={`shrink-0 text-[11px] ${cutsVisible ? 'text-text' : 'text-text-muted/40'}`}
            title={cutsVisible ? 'Hide cuts' : 'Show cuts'}
          >
            {cutsVisible ? '👁' : '👁‍🗨'}
          </button>
          <span className="truncate text-text-muted">Coupes</span>
        </div>
      </div>
      <div
        ref={scrollRef}
        className="relative flex-1 overflow-x-auto overflow-y-hidden rounded-r-md border border-border bg-bg-elev [scrollbar-width:thin]"
      >
      {/* Lane height: 30px per subtitle track + 30px text + 30px images + 30px cuts */}
      <div
        ref={trackRef}
        className="relative select-none"
        style={{
          width: `${zoom * 100}%`,
          minWidth: '100%',
          height: `${subtitleTracks.length * 30 + 90}px`,
        }}
        onClick={onTrackClick}
        onWheel={onWheel}
        title={`Click empty area to scrub · drag clip body to slide · drag edge to trim · Cmd+wheel to zoom · Shift+wheel to resize text (${style.fontSize}px)`}
      >
        {/* Audio waveform — sits at the bottom of the z-order so clip
            blocks render on top. pointer-events-none so the existing click
            handlers (scrub / drag) keep working. */}
        <canvas
          ref={canvasRef}
          className="pointer-events-none absolute inset-0 h-full w-full"
        />
        {/* Time grid markers — rendered under the clips so they act as a
            passive ruler. We draw one label every `tickInterval` seconds.
            The interval is computed from the VISIBLE portion of the track
            (duration / zoom) so tick density stays comfortable at every
            zoom level — zooming in shows finer subdivisions instead of
            the same ~8 labels stretched across a wider strip. */}
        {(() => {
          const tickInterval = pickTickInterval(videoDuration / zoom);
          const ticks: number[] = [];
          for (let t = 0; t <= videoDuration; t += tickInterval) ticks.push(t);
          return ticks.map((t) => {
            const left = (t / videoDuration) * 100;
            return (
              <div
                key={`tick-${t}`}
                className="pointer-events-none absolute top-0 bottom-0 border-l border-white/[0.06]"
                style={{ left: `${left}%` }}
              >
                <span className="absolute top-0.5 left-1 font-mono text-[9px] text-text-muted/70">
                  {fmtTick(t)}
                </span>
              </div>
            );
          });
        })()}

        {/* Subtitle lanes — one per track */}
        {subtitleTracks.map((track, trackIdx) =>
          track.blocks.map((b) => {
            const left = (b.start / videoDuration) * 100;
            const width = Math.max(
              0.4,
              ((b.end - b.start) / videoDuration) * 100,
            );
            const isActive = track.id === activeTrackId;
            const isSelected = isActive && selectedBlockId === b.id;
            const topPx = trackIdx * 30 + 3;
            return (
              <div
                key={`${track.id}-${b.id}`}
                className={`group absolute h-6 rounded transition-colors ${
                  !track.visible ? 'opacity-30' : ''
                } ${
                  isSelected
                    ? 'bg-accent ring-2 ring-white/70'
                    : isActive
                      ? 'bg-accent/70 hover:bg-accent'
                      : 'bg-purple-500/60 hover:bg-purple-500'
                }`}
                style={{ left: `${left}%`, width: `${width}%`, top: `${topPx}px` }}
                title={b.text}
                onPointerDown={isActive ? onDragStart({
                  type: 'block',
                  id: b.id,
                  kind: 'move',
                }) : undefined}
                onClick={(e) => {
                  if (drag) return;
                  e.stopPropagation();
                  if (!isActive) {
                    setActiveTrack(track.id);
                    return;
                  }
                  selectBlock(b.id);
                  window.dispatchEvent(
                    new CustomEvent('subifi:focus-block', {
                      detail: { id: b.id },
                    }),
                  );
                }}
              >
                {isActive && (
                  <>
                    <div
                      className="absolute top-0 left-0 h-full cursor-ew-resize rounded-l bg-white/30 hover:bg-white/70"
                      style={{ width: HANDLE_PX }}
                      onPointerDown={onDragStart({
                        type: 'block',
                        id: b.id,
                        kind: 'trim-start',
                      })}
                    />
                    <div
                      className="absolute top-0 right-0 h-full cursor-ew-resize rounded-r bg-white/30 hover:bg-white/70"
                      style={{ width: HANDLE_PX }}
                      onPointerDown={onDragStart({
                        type: 'block',
                        id: b.id,
                        kind: 'trim-end',
                      })}
                    />
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteBlock(b.id);
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                      className="absolute -top-1 -right-1 z-10 hidden h-3.5 w-3.5 items-center justify-center rounded-full bg-red-900/90 text-[9px] leading-none text-red-100 group-hover:flex hover:bg-red-700"
                      title="Delete this subtitle"
                    >
                      ×
                    </button>
                  </>
                )}
              </div>
            );
          }),
        )}

        {/* Text overlay lane */}
        {textOverlays.map((ov) => {
          const left = (ov.start / videoDuration) * 100;
          const width = Math.max(
            0.4,
            ((ov.end - ov.start) / videoDuration) * 100,
          );
          const isSelected = selectedTextOverlayId === ov.id;
          const textLaneTop = subtitleTracks.length * 30 + 3;
          return (
            <div
              key={ov.id}
              className={`group absolute h-6 rounded ${
                !textOverlaysVisible ? 'opacity-30' : ''
              } ${
                isSelected
                  ? 'bg-sky-400/80 ring-1 ring-sky-200'
                  : 'bg-sky-500/60 hover:bg-sky-500'
              }`}
              style={{ left: `${left}%`, width: `${width}%`, top: `${textLaneTop}px` }}
              title={ov.text}
              onPointerDown={onDragStart({
                type: 'text',
                id: ov.id,
                kind: 'move',
              })}
            >
              <div className="pointer-events-none absolute inset-0 truncate px-1 text-[10px] leading-6 text-white">
                {ov.text}
              </div>
              <div
                className="absolute top-0 left-0 h-full cursor-ew-resize rounded-l bg-white/30 hover:bg-white/70"
                style={{ width: HANDLE_PX }}
                onPointerDown={onDragStart({
                  type: 'text',
                  id: ov.id,
                  kind: 'trim-start',
                })}
              />
              <div
                className="absolute top-0 right-0 h-full cursor-ew-resize rounded-r bg-white/30 hover:bg-white/70"
                style={{ width: HANDLE_PX }}
                onPointerDown={onDragStart({
                  type: 'text',
                  id: ov.id,
                  kind: 'trim-end',
                })}
              />
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removeTextOverlay(ov.id);
                }}
                onPointerDown={(e) => e.stopPropagation()}
                className="absolute -top-1 -right-1 z-10 hidden h-3.5 w-3.5 items-center justify-center rounded-full bg-red-900/90 text-[9px] leading-none text-red-100 group-hover:flex hover:bg-red-700"
                title="Delete this text overlay"
              >
                ×
              </button>
            </div>
          );
        })}

        {/* Image overlay lane */}
        {overlays.map((ov) => {
          const left = (ov.start / videoDuration) * 100;
          const width = Math.max(
            0.4,
            ((ov.end - ov.start) / videoDuration) * 100,
          );
          const isSelected = selectedOverlayId === ov.id;
          const imgLaneTop = subtitleTracks.length * 30 + 33;
          return (
            <div
              key={ov.id}
              className={`group absolute h-6 overflow-hidden rounded ${
                !imageOverlaysVisible ? 'opacity-30' : ''
              } ${
                isSelected
                  ? 'bg-emerald-400/80 ring-1 ring-emerald-200'
                  : 'bg-emerald-500/60 hover:bg-emerald-500'
              }`}
              style={{ left: `${left}%`, width: `${width}%`, top: `${imgLaneTop}px` }}
              title={`Image overlay · ${(ov.end - ov.start).toFixed(2)}s`}
              onPointerDown={onDragStart({
                type: 'image',
                id: ov.id,
                kind: 'move',
              })}
            >
              {/* Tiny thumbnail of the image so the user can tell which
                  overlay each lane entry corresponds to. pointer-events-none
                  so it doesn't intercept the drag handler on the parent. */}
              <img
                src={ov.dataUrl}
                alt=""
                className="pointer-events-none absolute inset-y-0.5 left-0.5 h-5 w-5 rounded-sm object-cover opacity-90"
              />
              <div
                className="absolute top-0 left-0 h-full cursor-ew-resize rounded-l bg-white/30 hover:bg-white/70"
                style={{ width: HANDLE_PX }}
                onPointerDown={onDragStart({
                  type: 'image',
                  id: ov.id,
                  kind: 'trim-start',
                })}
              />
              <div
                className="absolute top-0 right-0 h-full cursor-ew-resize rounded-r bg-white/30 hover:bg-white/70"
                style={{ width: HANDLE_PX }}
                onPointerDown={onDragStart({
                  type: 'image',
                  id: ov.id,
                  kind: 'trim-end',
                })}
              />
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removeOverlay(ov.id);
                }}
                onPointerDown={(e) => e.stopPropagation()}
                className="absolute -top-1 -right-1 z-10 hidden h-3.5 w-3.5 items-center justify-center rounded-full bg-red-900/90 text-[9px] leading-none text-red-100 group-hover:flex hover:bg-red-700"
                title="Delete this image overlay"
              >
                ×
              </button>
            </div>
          );
        })}

        {/* Cut regions — full-height translucent red overlays. They sit on
            top of the lanes (so the user can see they cover everything in
            their range) but below the playhead. */}
        {cuts.map((c) => {
          const left = (c.start / videoDuration) * 100;
          const width = Math.max(
            0.4,
            ((c.end - c.start) / videoDuration) * 100,
          );
          return (
            <div
              key={c.id}
              className="absolute top-0 h-full bg-red-500/25 ring-1 ring-inset ring-red-400/60 hover:bg-red-500/35"
              style={{
                left: `${left}%`,
                width: `${width}%`,
                // Diagonal hatching makes it obvious this isn't a clip but
                // a removed region — distinct from the solid subtitle blocks.
                backgroundImage:
                  'repeating-linear-gradient(45deg, rgba(248,113,113,0.12) 0 6px, transparent 6px 12px)',
              }}
              title={`Cut · ${(c.end - c.start).toFixed(2)}s removed at export`}
              onPointerDown={onDragStart({
                type: 'cut',
                id: c.id,
                kind: 'move',
              })}
            >
              {/* Trim handles */}
              <div
                className="absolute top-0 left-0 h-full cursor-ew-resize bg-red-400/40 hover:bg-red-400/80"
                style={{ width: HANDLE_PX }}
                onPointerDown={onDragStart({
                  type: 'cut',
                  id: c.id,
                  kind: 'trim-start',
                })}
              />
              <div
                className="absolute top-0 right-0 h-full cursor-ew-resize bg-red-400/40 hover:bg-red-400/80"
                style={{ width: HANDLE_PX }}
                onPointerDown={onDragStart({
                  type: 'cut',
                  id: c.id,
                  kind: 'trim-end',
                })}
              />
              {/* Delete button — sits in the top-right corner of the cut.
                  stopPropagation so the click doesn't kick off a body drag. */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removeCut(c.id);
                }}
                onPointerDown={(e) => e.stopPropagation()}
                className="absolute top-0.5 right-1.5 z-10 rounded bg-red-900/70 px-1 text-[10px] leading-none text-red-100 hover:bg-red-800"
                title="Remove this cut"
              >
                ×
              </button>
            </div>
          );
        })}

        {/* playhead */}
        <div
          className="pointer-events-none absolute top-0 h-full w-0.5 bg-white"
          style={{ left: `${(currentTime / videoDuration) * 100}%` }}
        />
        {/* duration label */}
        <div className="pointer-events-none absolute bottom-0 right-2 text-[10px] text-text-muted">
          {Math.floor(videoDuration / 60)}:
          {(videoDuration % 60).toFixed(0).padStart(2, '0')}
        </div>
      </div>
      </div>
      </div>
    </div>
  );
}
