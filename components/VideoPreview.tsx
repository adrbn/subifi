'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditor } from '@/lib/store';
import { MediaSidebar } from '@/components/MediaSidebar';
import { computeSnap, buildGuideTargets, type Guide } from '@/lib/snap';
import type {
  ImageOverlay,
  SafeZone,
  Style,
  SubtitleBlock,
  TextOverlay,
} from '@/lib/types';

// WYSIWYG video preview: native <video> + absolutely-positioned DOM overlays
// for the active subtitle block, user image overlays, and safe-area guides.
// All overlays are draggable and wheel-zoomable so the user can position and
// size everything on the image without leaving the canvas.

function activeBlocks(blocks: SubtitleBlock[], t: number): SubtitleBlock[] {
  return blocks.filter((b) => t >= b.start && t <= b.end);
}

function toRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '').padEnd(6, '0');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

// Render text with a per-character wiggle animation. Splits on graphemes
// (via spread) so multi-byte codepoints stay intact; preserves \n by
// emitting <br /> and keeps spaces as non-collapsing spans so alignment
// is untouched. Each span gets a staggered animationDelay derived from
// its index so the motion looks organic, not synchronised.
function renderWiggleText(
  text: string,
  amplitude: number,
  speed: number,
  scale: number,
): React.ReactNode {
  const durationMs = Math.max(120, Math.round(1000 / Math.max(0.1, speed)));
  const ampPx = amplitude * scale * 0.5; // amplitude is in "degrees-ish"
  const rotDeg = amplitude;
  const lines = text.split('\n');
  const nodes: React.ReactNode[] = [];
  let idx = 0;
  lines.forEach((line, li) => {
    const chars = Array.from(line);
    chars.forEach((ch, ci) => {
      const delay = ((idx * 73) % durationMs) - durationMs;
      nodes.push(
        <span
          key={`${li}-${ci}`}
          style={{
            display: 'inline-block',
            whiteSpace: 'pre',
            animation: `subifi-wiggle ${durationMs}ms ease-in-out infinite`,
            animationDelay: `${delay}ms`,
            // Per-span CSS vars feed the keyframes.
            ['--wig-amp' as string]: `${ampPx}px`,
            ['--wig-rot' as string]: `${rotDeg}deg`,
          } as React.CSSProperties}
        >
          {ch}
        </span>,
      );
      idx++;
    });
    if (li < lines.length - 1) nodes.push(<br key={`br-${li}`} />);
  });
  return nodes;
}

function SafeZoneOverlay({ zone }: { zone: SafeZone }): React.ReactElement | null {
  if (zone.preset === 'off') return null;
  // Solid tint + dashed border. We deliberately avoid `mixBlendMode: multiply`
  // here: on dark underlying video content the multiply blend erased the red
  // band entirely, making the bottom "caption" zone look like it wasn't being
  // drawn at all. A constant-alpha fill plus a high-contrast dashed border
  // keeps the zones legible regardless of the video brightness.
  const band: React.CSSProperties = {
    position: 'absolute',
    background: 'rgba(220, 38, 38, 0.28)', // red-600 @ 28%
    border: '1px dashed rgba(248, 113, 113, 0.95)', // red-400
    boxSizing: 'border-box',
    pointerEvents: 'none',
  };
  return (
    <>
      {zone.topPct > 0 && (
        <div
          style={{
            ...band,
            top: 0,
            left: 0,
            right: 0,
            height: `${zone.topPct * 100}%`,
          }}
        />
      )}
      {zone.bottomPct > 0 && (
        <div
          style={{
            ...band,
            bottom: 0,
            left: 0,
            right: 0,
            height: `${zone.bottomPct * 100}%`,
          }}
        />
      )}
      {zone.leftPct > 0 && (
        <div
          style={{
            ...band,
            top: `${zone.topPct * 100}%`,
            bottom: `${zone.bottomPct * 100}%`,
            left: 0,
            width: `${zone.leftPct * 100}%`,
          }}
        />
      )}
      {zone.rightPct > 0 && (
        <div
          style={{
            ...band,
            top: `${zone.topPct * 100}%`,
            bottom: `${zone.bottomPct * 100}%`,
            right: 0,
            width: `${zone.rightPct * 100}%`,
          }}
        />
      )}
    </>
  );
}

function subtitleStyle(
  style: Style,
  scale: number,
  dragging: boolean,
): React.CSSProperties {
  const padX = style.backgroundPaddingX * scale;
  const padY = style.backgroundPaddingY * scale;
  const radius = style.backgroundRadius * scale;
  const bg =
    style.backgroundOpacity > 0
      ? toRgba(style.backgroundColor, style.backgroundOpacity)
      : 'transparent';
  const o = style.textOutlineWidth * scale;
  const outlineColor = style.textOutlineColor;
  const textShadow =
    o > 0
      ? [
          `${o}px 0 0 ${outlineColor}`,
          `-${o}px 0 0 ${outlineColor}`,
          `0 ${o}px 0 ${outlineColor}`,
          `0 -${o}px 0 ${outlineColor}`,
          `${o}px ${o}px 0 ${outlineColor}`,
          `-${o}px ${o}px 0 ${outlineColor}`,
          `${o}px -${o}px 0 ${outlineColor}`,
          `-${o}px -${o}px 0 ${outlineColor}`,
        ].join(', ')
      : 'none';

  return {
    position: 'absolute',
    left: `${style.positionX * 100}%`,
    top: `${style.positionY * 100}%`,
    transform: 'translate(-50%, -50%)',
    boxSizing: 'content-box' as const,
    // NO maxWidth — subtitles never auto-wrap. The segmenter already
    // inserts \n for multi-line blocks; CSS white-space: pre preserves
    // those line breaks without adding any automatic word-wrap.
    padding: `${padY}px ${padX}px`,
    borderRadius: `${radius}px`,
    background: bg,
    color: style.textColor,
    fontFamily: `"${style.fontFamily}", system-ui, sans-serif`,
    fontSize: `${style.fontSize * scale}px`,
    fontWeight: style.fontWeight,
    fontStyle: style.italic ? 'italic' : 'normal',
    textAlign: style.textAlign,
    textShadow,
    lineHeight: style.lineHeight ?? 1.2,
    letterSpacing: `${(style.letterSpacing ?? 0) * scale}px`,
    wordSpacing: `${(style.wordSpacing ?? 0) * scale}px`,
    whiteSpace: 'pre',
    pointerEvents: 'auto',
    userSelect: 'none',
    cursor: dragging ? 'grabbing' : 'grab',
    touchAction: 'none',
  };
}

function textOverlayStyle(
  ov: TextOverlay,
  scale: number,
  isSelected: boolean,
  dragging: boolean,
): React.CSSProperties {
  const padX = ov.backgroundPaddingX * scale;
  const padY = ov.backgroundPaddingY * scale;
  const radius = ov.backgroundRadius * scale;
  const bg =
    ov.backgroundOpacity > 0
      ? toRgba(ov.backgroundColor, ov.backgroundOpacity)
      : 'transparent';
  const o = ov.textOutlineWidth * scale;
  const outlineColor = ov.textOutlineColor;
  const textShadow =
    o > 0
      ? [
          `${o}px 0 0 ${outlineColor}`,
          `-${o}px 0 0 ${outlineColor}`,
          `0 ${o}px 0 ${outlineColor}`,
          `0 -${o}px 0 ${outlineColor}`,
          `${o}px ${o}px 0 ${outlineColor}`,
          `-${o}px ${o}px 0 ${outlineColor}`,
          `${o}px -${o}px 0 ${outlineColor}`,
          `-${o}px -${o}px 0 ${outlineColor}`,
        ].join(', ')
      : 'none';
  return {
    position: 'absolute',
    left: `${ov.positionX * 100}%`,
    top: `${ov.positionY * 100}%`,
    transform: 'translate(-50%, -50%)',
    boxSizing: 'content-box' as const,
    padding: `${padY}px ${padX}px`,
    borderRadius: `${radius}px`,
    background: bg,
    color: ov.textColor,
    fontFamily: `"${ov.fontFamily}", system-ui, sans-serif`,
    fontSize: `${ov.fontSize * scale}px`,
    fontWeight: ov.fontWeight,
    fontStyle: ov.italic ? 'italic' : 'normal',
    textAlign: ov.textAlign,
    textShadow,
    lineHeight: 1.2,
    whiteSpace: 'pre',
    pointerEvents: 'auto',
    userSelect: 'none',
    cursor: dragging ? 'grabbing' : 'grab',
    touchAction: 'none',
    outline: isSelected ? '2px dashed #60a5fa' : 'none',
    outlineOffset: 4,
  };
}

function imageOverlayStyle(
  ov: ImageOverlay,
  isSelected: boolean,
  dragging: boolean,
): React.CSSProperties {
  return {
    position: 'absolute',
    left: `${ov.positionX * 100}%`,
    top: `${ov.positionY * 100}%`,
    width: `${ov.width * 100}%`,
    height: 'auto',
    transform: 'translate(-50%, -50%)',
    opacity: ov.opacity,
    userSelect: 'none',
    touchAction: 'none',
    cursor: dragging ? 'grabbing' : 'grab',
    outline: isSelected ? '2px solid #60a5fa' : 'none',
    outlineOffset: 2,
  };
}

export function VideoPreview() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // We fullscreen the outer centering wrapper (not the aspect-ratio box
  // inside it) so the browser's fullscreen style fills the screen, and
  // the inner box letterboxes itself via its own aspectRatio / max-*
  // constraints. Everything absolutely-positioned inside the inner box
  // (subtitles, text overlays, images, safe-zone) comes along for free,
  // which is the whole point of NOT using the native <video> fullscreen.
  const fsWrapperRef = useRef<HTMLDivElement>(null);
  const {
    videoUrl,
    videoWidth,
    videoHeight,
    blocks,
    style,
    overlays,
    imageOverlaysVisible,
    selectedOverlayId,
    textOverlays,
    textOverlaysVisible,
    selectedTextOverlayId,
    safeZone,
    setCurrentTime,
    setStyle,
    updateOverlay,
    removeOverlay,
    selectOverlay,
    updateTextOverlay,
    selectTextOverlay,
    selectedBlockId,
    selectBlock,
    updateBlock,
    subtitleTracks,
  } = useEditor();
  const [t, setT] = useState(0);
  const [scale, setScale] = useState(1);
  const [subtitleDragging, setSubtitleDragging] = useState(false);
  const [draggingOverlayId, setDraggingOverlayId] = useState<string | null>(
    null,
  );
  const [draggingTextOverlayId, setDraggingTextOverlayId] = useState<
    string | null
  >(null);
  const [editingTextOverlayId, setEditingTextOverlayId] = useState<
    string | null
  >(null);
  // Which subtitle block is currently being edited inline via dblclick on
  // the preview. Distinct from `selectedBlockId` — selection just tells
  // the renderer to highlight it, editing opens a textarea in place.
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [activeGuides, setActiveGuides] = useState<Guide[]>([]);

  // --- Subtitle drag ---------------------------------------------------------
  const onSubtitlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!containerRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      setSubtitleDragging(true);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      const rect = containerRef.current.getBoundingClientRect();

      const move = (ev: PointerEvent) => {
        const rawX = clamp01((ev.clientX - rect.left) / rect.width);
        const rawY = clamp01((ev.clientY - rect.top) / rect.height);
        const targets = buildGuideTargets({
          safeZone,
          textOverlays: textOverlays.filter(
            (o) => t >= o.start && t <= o.end,
          ),
          imageOverlays: overlays.filter(
            (o) => t >= o.start - 0.001 && t <= o.end + 0.001,
          ),
          excludeSubtitle: true,
        });
        const snapped = computeSnap(rawX, rawY, targets);
        setStyle({ positionX: snapped.x, positionY: snapped.y });
        setActiveGuides(snapped.guides);
      };
      const up = () => {
        setSubtitleDragging(false);
        setActiveGuides([]);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [setStyle, safeZone, textOverlays, overlays, t],
  );

  // --- Subtitle wheel zoom ---------------------------------------------------
  const onSubtitleWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const delta = e.deltaY;
      // 1 wheel notch ≈ ~100 deltaY in most browsers. Scale ~2 px per notch.
      const step = delta > 0 ? -2 : 2;
      const next = Math.max(10, Math.min(240, style.fontSize + step));
      setStyle({ fontSize: next });
    },
    [style.fontSize, setStyle],
  );

  // --- Image overlay drag ----------------------------------------------------
  const onOverlayPointerDown = useCallback(
    (ovId: string) => (e: React.PointerEvent<HTMLImageElement>) => {
      if (!containerRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      setDraggingOverlayId(ovId);
      selectOverlay(ovId);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      const rect = containerRef.current.getBoundingClientRect();

      const move = (ev: PointerEvent) => {
        const rawX = clamp01((ev.clientX - rect.left) / rect.width);
        const rawY = clamp01((ev.clientY - rect.top) / rect.height);
        const targets = buildGuideTargets({
          safeZone,
          textOverlays: textOverlays.filter(
            (o) => t >= o.start && t <= o.end,
          ),
          imageOverlays: overlays.filter(
            (o) => t >= o.start - 0.001 && t <= o.end + 0.001,
          ),
          excludeId: ovId,
          subtitlePosition: { x: style.positionX, y: style.positionY },
        });
        const snapped = computeSnap(rawX, rawY, targets);
        updateOverlay(ovId, { positionX: snapped.x, positionY: snapped.y });
        setActiveGuides(snapped.guides);
      };
      const up = () => {
        setDraggingOverlayId(null);
        setActiveGuides([]);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [updateOverlay, selectOverlay, safeZone, textOverlays, overlays, style.positionX, style.positionY, t],
  );

  // --- Image overlay wheel zoom ----------------------------------------------
  const onOverlayWheel = useCallback(
    (ov: ImageOverlay) => (e: React.WheelEvent<HTMLImageElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const factor = e.deltaY > 0 ? 0.92 : 1.08;
      const next = Math.max(0.02, Math.min(1, ov.width * factor));
      updateOverlay(ov.id, { width: next });
    },
    [updateOverlay],
  );

  // --- Text overlay drag -----------------------------------------------------
  const onTextOverlayPointerDown = useCallback(
    (ovId: string) => (e: React.PointerEvent<HTMLDivElement>) => {
      if (!containerRef.current) return;
      // If the user is editing this overlay's text via the inline editor,
      // pointer events go straight into the textarea — don't hijack them.
      if (editingTextOverlayId === ovId) return;
      e.preventDefault();
      e.stopPropagation();
      setDraggingTextOverlayId(ovId);
      selectTextOverlay(ovId);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      const rect = containerRef.current.getBoundingClientRect();
      const move = (ev: PointerEvent) => {
        const rawX = clamp01((ev.clientX - rect.left) / rect.width);
        const rawY = clamp01((ev.clientY - rect.top) / rect.height);
        const targets = buildGuideTargets({
          safeZone,
          textOverlays: textOverlays.filter(
            (o) => t >= o.start && t <= o.end,
          ),
          imageOverlays: overlays.filter(
            (o) => t >= o.start - 0.001 && t <= o.end + 0.001,
          ),
          excludeId: ovId,
          subtitlePosition: { x: style.positionX, y: style.positionY },
        });
        const snapped = computeSnap(rawX, rawY, targets);
        updateTextOverlay(ovId, {
          positionX: snapped.x,
          positionY: snapped.y,
        });
        setActiveGuides(snapped.guides);
      };
      const up = () => {
        setDraggingTextOverlayId(null);
        setActiveGuides([]);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [editingTextOverlayId, selectTextOverlay, updateTextOverlay, safeZone, overlays, style.positionX, style.positionY, t],
  );

  // --- Text overlay wheel zoom -----------------------------------------------
  const onTextOverlayWheel = useCallback(
    (ov: TextOverlay) => (e: React.WheelEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const step = e.deltaY > 0 ? -2 : 2;
      const next = Math.max(8, Math.min(240, ov.fontSize + step));
      updateTextOverlay(ov.id, { fontSize: next });
    },
    [updateTextOverlay],
  );

  // --- Expose video element to SubtitleList for scrubbing -------------------
  useEffect(() => {
    if (!videoRef.current) return;
    (window as unknown as { __previewVideo?: HTMLVideoElement }).__previewVideo =
      videoRef.current;
    return () => {
      if (
        (window as unknown as { __previewVideo?: HTMLVideoElement })
          .__previewVideo === videoRef.current
      ) {
        delete (window as unknown as { __previewVideo?: HTMLVideoElement })
          .__previewVideo;
      }
    };
  }, []);

  // --- Fullscreen tracking + toggle -----------------------------------------
  // We drive fullscreen from the wrapper div rather than the <video> so all
  // the absolutely-positioned overlays (subtitles, text, image, safe-zone)
  // come with it. Native fullscreen on the <video> element would strip them.
  useEffect(() => {
    const onChange = () => {
      setIsFullscreen(document.fullscreenElement === fsWrapperRef.current);
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    if (!fsWrapperRef.current) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await fsWrapperRef.current.requestFullscreen();
      }
    } catch {
      // ignore — some environments (iOS Safari in iframes) don't support
      // element fullscreen and just throw.
    }
  }, []);

  // --- Recompute display scale -----------------------------------------------
  useEffect(() => {
    const recompute = () => {
      if (!containerRef.current || !videoWidth) return;
      const rect = containerRef.current.getBoundingClientRect();
      if (rect.width === 0) return;
      setScale(rect.width / videoWidth);
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [videoWidth, videoHeight, videoUrl]);

  // Show blocks from all visible tracks, not just the active one.
  // Each block carries a `trackIdx` so we can offset the Y position when
  // multiple tracks have overlapping blocks — preventing visual overlap.
  const visibleTrackList = subtitleTracks.filter((tr) => tr.visible);
  const currentBlocks: Array<SubtitleBlock & { _trackIdx: number; _trackCount: number }> = [];
  for (let ti = 0; ti < visibleTrackList.length; ti++) {
    for (const b of visibleTrackList[ti].blocks) {
      if (t >= b.start && t <= b.end) {
        currentBlocks.push({ ...b, _trackIdx: ti, _trackCount: visibleTrackList.length });
      }
    }
  }

  if (!videoUrl) {
    return (
      <div className="flex h-full w-full items-center justify-center rounded-xl border border-border bg-bg-elev text-sm text-text-muted">
        Preview will appear here once a video is loaded.
      </div>
    );
  }

  const aspect = videoWidth && videoHeight ? videoWidth / videoHeight : 16 / 9;

  return (
    <div
      ref={fsWrapperRef}
      data-tour="preview"
      className={`relative flex h-full w-full items-center justify-center ${
        isFullscreen ? 'bg-black' : ''
      }`}
    >
      {/* Mobile-only sidebar — absolutely positioned so the video box is
          the sole flex child and gets perfectly centered. The sidebar
          overlays the left edge without pushing the video right. */}
      <div className="pointer-events-none absolute inset-y-0 left-1 z-10 flex flex-col items-center justify-center md:hidden">
        <div className="pointer-events-auto">
          <MediaSidebar />
        </div>
      </div>
      <div
        ref={containerRef}
        className="relative max-h-full max-w-full overflow-hidden rounded-xl border border-border bg-black"
        style={{ aspectRatio: aspect }}
        onPointerDown={(e) => {
          // Click on empty canvas area deselects every overlay/block so the
          // user has a clear "reset focus" gesture without needing a button.
          if (e.target === e.currentTarget) {
            selectOverlay(null);
            selectTextOverlay(null);
            selectBlock(null);
          }
        }}
      >
        <video
          ref={videoRef}
          src={videoUrl}
          className="h-full w-full"
          controls
          playsInline
          // Ask the browser to hide the native fullscreen button from the
          // built-in controls so users go through our custom toggle, which
          // fullscreens the whole wrapper (video + overlays) instead of
          // just the video element. Chrome/Edge/Firefox honor this; older
          // Safari ignores it but the custom button still works.
          controlsList="nofullscreen"
          disablePictureInPicture
          onTimeUpdate={(e) => {
            const nt = (e.target as HTMLVideoElement).currentTime;
            setT(nt);
            setCurrentTime(nt);
          }}
        />

        {/* Custom fullscreen toggle — corner button on the video that
            fullscreens the wrapper, so overlays stay visible. Hidden on
            very small previews to avoid covering the video. */}
        <button
          type="button"
          onClick={toggleFullscreen}
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute top-2 right-2 z-20 flex h-8 w-8 items-center justify-center rounded-md bg-black/55 text-white/90 backdrop-blur-sm transition-colors hover:bg-black/80"
          title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen (with overlays)'}
          aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        >
          {isFullscreen ? (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M8 3v3a2 2 0 0 1-2 2H3" />
              <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
              <path d="M3 16h3a2 2 0 0 1 2 2v3" />
              <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
            </svg>
          ) : (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M8 3H5a2 2 0 0 0-2 2v3" />
              <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
              <path d="M3 16v3a2 2 0 0 0 2 2h3" />
              <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
            </svg>
          )}
        </button>

        <SafeZoneOverlay zone={safeZone} />

        {(imageOverlaysVisible ? overlays : [])
          .filter((ov) => t >= ov.start - 0.001 && t <= ov.end + 0.001)
          .map((ov) => (
            <div
              key={ov.id}
              style={imageOverlayStyle(
                ov,
                selectedOverlayId === ov.id,
                draggingOverlayId === ov.id,
              )}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={ov.dataUrl}
                alt="overlay"
                style={{ width: '100%', height: 'auto', display: 'block' }}
                onPointerDown={onOverlayPointerDown(ov.id)}
                onWheel={onOverlayWheel(ov)}
                draggable={false}
                title="Drag to move · wheel to resize"
              />
              {selectedOverlayId === ov.id && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); removeOverlay(ov.id); }}
                  className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-red-600 text-[10px] font-bold text-white shadow hover:bg-red-500"
                  title="Remove overlay"
                >
                  ✕
                </button>
              )}
            </div>
          ))}

        {/* Text overlays — below subtitles in z-order (matching timeline:
            subs on top, then texts, then images at the bottom). */}
        {(textOverlaysVisible ? textOverlays : [])
          .filter((ov) => t >= ov.start - 0.001 && t <= ov.end + 0.001)
          .map((ov) => (
            <div
              key={ov.id}
              style={textOverlayStyle(
                ov,
                scale,
                selectedTextOverlayId === ov.id,
                draggingTextOverlayId === ov.id,
              )}
              onPointerDown={onTextOverlayPointerDown(ov.id)}
              onWheel={onTextOverlayWheel(ov)}
              onDoubleClick={(e) => {
                e.stopPropagation();
                setEditingTextOverlayId(ov.id);
                selectTextOverlay(ov.id);
              }}
              title="Drag to move · wheel to resize · double-click to edit text"
            >
              {editingTextOverlayId === ov.id ? (
                <textarea
                  autoFocus
                  value={ov.text}
                  onChange={(e) =>
                    updateTextOverlay(ov.id, { text: e.target.value })
                  }
                  onBlur={() => setEditingTextOverlayId(null)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setEditingTextOverlayId(null);
                    e.stopPropagation();
                  }}
                  rows={Math.max(1, ov.text.split('\n').length)}
                  className="resize-none bg-transparent text-center outline-none"
                  style={{
                    color: 'inherit',
                    font: 'inherit',
                    width: '100%',
                    minWidth: 80,
                  }}
                />
              ) : ov.wiggle ? (
                renderWiggleText(
                  ov.text,
                  ov.wiggleAmplitude ?? 6,
                  ov.wiggleSpeed ?? 2,
                  scale,
                )
              ) : (
                ov.text
              )}
            </div>
          ))}

        {/* Subtitle blocks — topmost layer (matching timeline order). */}
        {/* Snap guide lines — only visible while dragging */}
        {activeGuides.map((g, i) =>
          g.axis === 'x' ? (
            <div
              key={`guide-${i}`}
              className="pointer-events-none absolute top-0 bottom-0"
              style={{
                left: `${g.position * 100}%`,
                width: 0,
                borderLeft: '1px dashed rgba(0, 200, 255, 0.8)',
                zIndex: 90,
              }}
            />
          ) : (
            <div
              key={`guide-${i}`}
              className="pointer-events-none absolute left-0 right-0"
              style={{
                top: `${g.position * 100}%`,
                height: 0,
                borderTop: '1px dashed rgba(0, 200, 255, 0.8)',
                zIndex: 90,
              }}
            />
          ),
        )}

        {currentBlocks.map((blk) => {
          const effectiveStyle = blk.styleOverride
            ? { ...style, ...blk.styleOverride }
            : style;
          const renderKaraoke =
            effectiveStyle.karaoke && blk.words && blk.words.length > 0;
          const isSelected = selectedBlockId === blk.id;
          const isEditing = editingBlockId === blk.id;
          // When multiple visible tracks have overlapping blocks, offset
          // each track's blocks vertically so they don't render on top of
          // each other. Track 0 stays at the original position; subsequent
          // tracks shift up progressively.
          const needsOffset = blk._trackCount > 1 && blk._trackIdx > 0;
          const offsetStyle: Style = needsOffset
            ? {
                ...effectiveStyle,
                positionY: Math.max(
                  0.05,
                  effectiveStyle.positionY - blk._trackIdx * 0.08,
                ),
              }
            : effectiveStyle;
          const baseStyle = subtitleStyle(
            offsetStyle,
            scale,
            subtitleDragging,
          );
          const styled: React.CSSProperties = isSelected
            ? {
                ...baseStyle,
                outline: '2px dashed #60a5fa',
                outlineOffset: 4,
              }
            : baseStyle;
          return (
            <div
              key={blk.id}
              style={styled}
              onPointerDown={(e) => {
                if (isEditing) return;
                selectBlock(blk.id);
                onSubtitlePointerDown(e);
              }}
              onWheel={onSubtitleWheel}
              onDoubleClick={(e) => {
                e.stopPropagation();
                videoRef.current?.pause();
                selectBlock(blk.id);
                setEditingBlockId(blk.id);
              }}
              title="Drag · wheel zoom · double-click to edit"
            >
              {isEditing ? (
                <textarea
                  autoFocus
                  value={blk.text}
                  onChange={(e) =>
                    updateBlock(blk.id, { text: e.target.value })
                  }
                  onBlur={() => setEditingBlockId(null)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setEditingBlockId(null);
                    }
                    e.stopPropagation();
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  rows={Math.max(1, blk.text.split('\n').length)}
                  className="resize-none bg-transparent text-center outline-none"
                  style={{
                    color: 'inherit',
                    font: 'inherit',
                    width: '100%',
                    minWidth: 120,
                  }}
                />
              ) : renderKaraoke ? (
                blk.words!.map((w, i) => {
                  const spoken = t >= w.end;
                  const active = t >= w.start && t < w.end;
                  return (
                    <span
                      key={i}
                      style={{
                        color:
                          spoken || active
                            ? effectiveStyle.textColor
                            : effectiveStyle.karaokeBaseColor,
                        transform: active ? 'scale(1.08)' : 'none',
                        display: 'inline-block',
                        transition: 'color 80ms linear',
                      }}
                    >
                      {w.text}
                      {i < blk.words!.length - 1 ? ' ' : ''}
                    </span>
                  );
                })
              ) : effectiveStyle.wiggle ? (
                renderWiggleText(
                  blk.text,
                  effectiveStyle.wiggleAmplitude ?? 6,
                  effectiveStyle.wiggleSpeed ?? 2,
                  scale,
                )
              ) : (
                blk.text
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
