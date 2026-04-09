'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditor } from '@/lib/store';
import type {
  ImageOverlay,
  SafeZone,
  Style,
  SubtitleBlock,
} from '@/lib/types';

// WYSIWYG video preview: native <video> + absolutely-positioned DOM overlays
// for the active subtitle block, user image overlays, and safe-area guides.
// All overlays are draggable and wheel-zoomable so the user can position and
// size everything on the image without leaving the canvas.

function activeBlock(blocks: SubtitleBlock[], t: number): SubtitleBlock | null {
  return blocks.find((b) => t >= b.start && t <= b.end) ?? null;
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
    maxWidth: `${style.maxWidth * 100}%`,
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
    lineHeight: 1.2,
    whiteSpace: 'pre-wrap',
    pointerEvents: 'auto',
    userSelect: 'none',
    cursor: dragging ? 'grabbing' : 'grab',
    touchAction: 'none',
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
  const {
    videoUrl,
    videoWidth,
    videoHeight,
    blocks,
    style,
    overlays,
    selectedOverlayId,
    safeZone,
    setCurrentTime,
    setStyle,
    updateOverlay,
    selectOverlay,
  } = useEditor();
  const [t, setT] = useState(0);
  const [scale, setScale] = useState(1);
  const [subtitleDragging, setSubtitleDragging] = useState(false);
  const [draggingOverlayId, setDraggingOverlayId] = useState<string | null>(
    null,
  );

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
        const x = (ev.clientX - rect.left) / rect.width;
        const y = (ev.clientY - rect.top) / rect.height;
        setStyle({ positionX: clamp01(x), positionY: clamp01(y) });
      };
      const up = () => {
        setSubtitleDragging(false);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [setStyle],
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
        const x = (ev.clientX - rect.left) / rect.width;
        const y = (ev.clientY - rect.top) / rect.height;
        updateOverlay(ovId, { positionX: clamp01(x), positionY: clamp01(y) });
      };
      const up = () => {
        setDraggingOverlayId(null);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [updateOverlay, selectOverlay],
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

  const block = activeBlock(blocks, t);

  if (!videoUrl) {
    return (
      <div className="flex h-full w-full items-center justify-center rounded-xl border border-border bg-bg-elev text-sm text-text-muted">
        Preview will appear here once a video is loaded.
      </div>
    );
  }

  const aspect = videoWidth && videoHeight ? videoWidth / videoHeight : 16 / 9;

  return (
    <div className="flex h-full w-full items-center justify-center">
      <div
        ref={containerRef}
        className="relative max-h-full max-w-full overflow-hidden rounded-xl border border-border bg-black"
        style={{ aspectRatio: aspect }}
        onPointerDown={(e) => {
          // Click on empty canvas area deselects any image overlay.
          if (e.target === e.currentTarget) selectOverlay(null);
        }}
      >
        <video
          ref={videoRef}
          src={videoUrl}
          className="h-full w-full"
          controls
          onTimeUpdate={(e) => {
            const nt = (e.target as HTMLVideoElement).currentTime;
            setT(nt);
            setCurrentTime(nt);
          }}
        />

        <SafeZoneOverlay zone={safeZone} />

        {overlays.map((ov) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={ov.id}
            src={ov.dataUrl}
            alt="overlay"
            style={imageOverlayStyle(
              ov,
              selectedOverlayId === ov.id,
              draggingOverlayId === ov.id,
            )}
            onPointerDown={onOverlayPointerDown(ov.id)}
            onWheel={onOverlayWheel(ov)}
            draggable={false}
            title="Drag to move · wheel to resize"
          />
        ))}

        {block && (
          <div
            style={subtitleStyle(style, scale, subtitleDragging)}
            onPointerDown={onSubtitlePointerDown}
            onWheel={onSubtitleWheel}
            title="Drag to reposition · wheel to zoom"
          >
            {block.text}
          </div>
        )}
      </div>
    </div>
  );
}
