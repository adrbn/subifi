// Snap-to-guide logic for the WYSIWYG preview. Given a dragged position
// (0..1 normalized) and a set of guide positions, returns the snapped
// position + which guides are active (so the caller can render lines).

export type Guide = {
  axis: 'x' | 'y';
  position: number; // 0..1
};

export type SnapResult = {
  x: number;
  y: number;
  guides: Guide[];
};

const SNAP_THRESHOLD = 0.015; // ~1.5% of container — ~8px on a 540px preview

export function computeSnap(
  x: number,
  y: number,
  targets: Guide[],
): SnapResult {
  let snappedX = x;
  let snappedY = y;
  const activeGuides: Guide[] = [];

  let bestDx = SNAP_THRESHOLD;
  let bestDy = SNAP_THRESHOLD;

  for (const g of targets) {
    if (g.axis === 'x') {
      const d = Math.abs(x - g.position);
      if (d < bestDx) {
        bestDx = d;
        snappedX = g.position;
      }
    } else {
      const d = Math.abs(y - g.position);
      if (d < bestDy) {
        bestDy = d;
        snappedY = g.position;
      }
    }
  }

  // Collect all guides that match the snapped position (there may be
  // multiple at the same coordinate — e.g. center + another element edge).
  for (const g of targets) {
    if (g.axis === 'x' && Math.abs(snappedX - g.position) < 0.001) {
      activeGuides.push(g);
    } else if (g.axis === 'y' && Math.abs(snappedY - g.position) < 0.001) {
      activeGuides.push(g);
    }
  }

  return { x: snappedX, y: snappedY, guides: activeGuides };
}

// Build the list of snap targets from the current editor state. Includes:
// - Center cross (0.5, 0.5)
// - Safe zone boundaries (if active)
// - Edges/centers of other visible elements (text overlays, image overlays)
export function buildGuideTargets(opts: {
  safeZone: { topPct: number; bottomPct: number; leftPct: number; rightPct: number; preset: string };
  textOverlays: Array<{ id: string; positionX: number; positionY: number }>;
  imageOverlays: Array<{ id: string; positionX: number; positionY: number }>;
  excludeId?: string; // the element being dragged
  subtitlePosition?: { x: number; y: number }; // current subtitle center
  excludeSubtitle?: boolean; // when dragging the subtitle itself
}): Guide[] {
  const guides: Guide[] = [
    { axis: 'x', position: 0.5 },
    { axis: 'y', position: 0.5 },
  ];

  // Safe zone edges
  if (opts.safeZone.preset !== 'off') {
    const sz = opts.safeZone;
    if (sz.topPct > 0) guides.push({ axis: 'y', position: sz.topPct });
    if (sz.bottomPct > 0) guides.push({ axis: 'y', position: 1 - sz.bottomPct });
    if (sz.leftPct > 0) guides.push({ axis: 'x', position: sz.leftPct });
    if (sz.rightPct > 0) guides.push({ axis: 'x', position: 1 - sz.rightPct });
  }

  // Other text overlays
  for (const ov of opts.textOverlays) {
    if (ov.id === opts.excludeId) continue;
    guides.push({ axis: 'x', position: ov.positionX });
    guides.push({ axis: 'y', position: ov.positionY });
  }

  // Image overlays
  for (const ov of opts.imageOverlays) {
    if (ov.id === opts.excludeId) continue;
    guides.push({ axis: 'x', position: ov.positionX });
    guides.push({ axis: 'y', position: ov.positionY });
  }

  // Subtitle center (snap other elements to the subtitle position)
  if (opts.subtitlePosition && !opts.excludeSubtitle) {
    guides.push({ axis: 'x', position: opts.subtitlePosition.x });
    guides.push({ axis: 'y', position: opts.subtitlePosition.y });
  }

  return guides;
}
