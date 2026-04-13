# Editor Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add snap guides, timeline-click-to-seek, overlap prevention, expanded per-block style overrides, project export/import, and style preset export/import.

**Architecture:** Seven independent features touching the preview drag system (`VideoPreview.tsx`), timeline click handlers (`Timeline.tsx`), block mutation validators (`store.ts`), per-block style UI (`SubtitleList.tsx`), and new serialization utilities (`lib/project-file.ts`, `lib/style-file.ts`). A shared snap utility (`lib/snap.ts`) is extracted for the preview. Each feature is self-contained and committable independently.

**Tech Stack:** React 18 + Next.js 15 + Zustand + TypeScript

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `lib/snap.ts` | Create | Snap-to-guide math for preview drag (center lines, element edges, safe zones) |
| `components/VideoPreview.tsx` | Modify | Wire snap into all 3 drag handlers, render guide lines |
| `components/Timeline.tsx` | Modify | Add seek-on-click to block click handler, add overlap clamping to block drag |
| `lib/store.ts` | Modify | Add overlap clamping in `updateBlock` |
| `components/SubtitleList.tsx` | Modify | Expand per-block style override panel, add time-input overlap clamping |
| `lib/project-file.ts` | Create | Serialize/deserialize full project state to/from JSON |
| `lib/style-file.ts` | Create | Serialize/deserialize style presets to/from JSON |
| `components/ExportBar.tsx` | Modify | Add project export/import buttons + style export/import |
| `components/PresetsBar.tsx` | Modify | Add style export/import buttons |

---

## Task 1: Snap Guides in Preview

**Files:**
- Create: `lib/snap.ts`
- Modify: `components/VideoPreview.tsx`

### Step 1.1: Create `lib/snap.ts`

- [ ] Create the snap utility module:

```typescript
// lib/snap.ts
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
```

- [ ] Verify TypeScript compiles: `npx tsc --noEmit`

### Step 1.2: Wire snap into subtitle drag handler

- [ ] In `components/VideoPreview.tsx`, add imports at the top:

```typescript
import { computeSnap, buildGuideTargets, type Guide } from '@/lib/snap';
```

- [ ] Add guide state alongside the existing `subtitleDragging` state:

```typescript
const [activeGuides, setActiveGuides] = useState<Guide[]>([]);
```

- [ ] Modify the `onSubtitlePointerDown` callback's `move` handler. Replace the raw `clamp01` positioning with snap-aware positioning. In the `move` closure:

Replace:
```typescript
const move = (ev: PointerEvent) => {
  const x = (ev.clientX - rect.left) / rect.width;
  const y = (ev.clientY - rect.top) / rect.height;
  setStyle({ positionX: clamp01(x), positionY: clamp01(y) });
};
```

With:
```typescript
const move = (ev: PointerEvent) => {
  const rawX = clamp01((ev.clientX - rect.left) / rect.width);
  const rawY = clamp01((ev.clientY - rect.top) / rect.height);
  const targets = buildGuideTargets({
    safeZone,
    textOverlays: textOverlays.filter(
      (o) => currentTime >= o.start && currentTime <= o.end,
    ),
    imageOverlays: overlays.filter(
      (o) => currentTime >= o.start - 0.001 && currentTime <= o.end + 0.001,
    ),
    excludeSubtitle: true,
  });
  const snap = computeSnap(rawX, rawY, targets);
  setStyle({ positionX: snap.x, positionY: snap.y });
  setActiveGuides(snap.guides);
};
```

- [ ] In the `up` handler, clear guides:

```typescript
const up = () => {
  setSubtitleDragging(false);
  setActiveGuides([]);
  window.removeEventListener('pointermove', move);
  window.removeEventListener('pointerup', up);
};
```

- [ ] Add `safeZone, textOverlays, overlays, currentTime` to the dependency array of the `useCallback`.

### Step 1.3: Wire snap into image overlay drag handler

- [ ] In `onOverlayPointerDown`, replace the `move` closure:

Replace:
```typescript
const move = (ev: PointerEvent) => {
  const x = (ev.clientX - rect.left) / rect.width;
  const y = (ev.clientY - rect.top) / rect.height;
  updateOverlay(ovId, { positionX: clamp01(x), positionY: clamp01(y) });
};
```

With:
```typescript
const move = (ev: PointerEvent) => {
  const rawX = clamp01((ev.clientX - rect.left) / rect.width);
  const rawY = clamp01((ev.clientY - rect.top) / rect.height);
  const targets = buildGuideTargets({
    safeZone,
    textOverlays: textOverlays.filter(
      (o) => currentTime >= o.start && currentTime <= o.end,
    ),
    imageOverlays: overlays.filter(
      (o) => currentTime >= o.start - 0.001 && currentTime <= o.end + 0.001,
    ),
    excludeId: ovId,
    subtitlePosition: { x: style.positionX, y: style.positionY },
  });
  const snap = computeSnap(rawX, rawY, targets);
  updateOverlay(ovId, { positionX: snap.x, positionY: snap.y });
  setActiveGuides(snap.guides);
};
```

- [ ] In the `up` handler, add `setActiveGuides([])`.
- [ ] Add `safeZone, textOverlays, style.positionX, style.positionY, currentTime` to the deps.

### Step 1.4: Wire snap into text overlay drag handler

- [ ] In `onTextOverlayPointerDown`, replace the `move` closure similarly:

```typescript
const move = (ev: PointerEvent) => {
  const rawX = clamp01((ev.clientX - rect.left) / rect.width);
  const rawY = clamp01((ev.clientY - rect.top) / rect.height);
  const targets = buildGuideTargets({
    safeZone,
    textOverlays: textOverlays.filter(
      (o) => currentTime >= o.start && currentTime <= o.end,
    ),
    imageOverlays: overlays.filter(
      (o) => currentTime >= o.start - 0.001 && currentTime <= o.end + 0.001,
    ),
    excludeId: ovId,
    subtitlePosition: { x: style.positionX, y: style.positionY },
  });
  const snap = computeSnap(rawX, rawY, targets);
  updateTextOverlay(ovId, { positionX: snap.x, positionY: snap.y });
  setActiveGuides(snap.guides);
};
```

- [ ] In the `up` handler, add `setActiveGuides([])`.
- [ ] Add `safeZone, overlays, style.positionX, style.positionY, currentTime` to the deps.

### Step 1.5: Render guide lines

- [ ] In VideoPreview's JSX, add guide line rendering just before the closing `</div>` of the preview container (the div with `ref={containerRef}`):

```tsx
{/* Snap guide lines — only visible while dragging */}
{activeGuides.map((g, i) =>
  g.axis === 'x' ? (
    <div
      key={`guide-${i}`}
      className="pointer-events-none absolute top-0 bottom-0"
      style={{
        left: `${g.position * 100}%`,
        width: '1px',
        background: 'rgba(0, 200, 255, 0.6)',
        borderLeft: '1px dashed rgba(0, 200, 255, 0.9)',
      }}
    />
  ) : (
    <div
      key={`guide-${i}`}
      className="pointer-events-none absolute left-0 right-0"
      style={{
        top: `${g.position * 100}%`,
        height: '1px',
        background: 'rgba(0, 200, 255, 0.6)',
        borderTop: '1px dashed rgba(0, 200, 255, 0.9)',
      }}
    />
  ),
)}
```

- [ ] Verify build: `npx tsc --noEmit`

### Step 1.6: Commit

```bash
git add lib/snap.ts components/VideoPreview.tsx
git commit -m "feat: snap guides when dragging elements in preview"
```

---

## Task 2: Timeline Click-to-Seek

**Files:**
- Modify: `components/Timeline.tsx`

### Step 2.1: Add seek on block click

- [ ] In `Timeline.tsx`, find the block `onClick` handler (around line 746). It currently does:

```typescript
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
```

Add a `scrub(b.start / videoDuration)` call right after `selectBlock(b.id)`:

```typescript
onClick={(e) => {
  if (drag) return;
  e.stopPropagation();
  if (!isActive) {
    setActiveTrack(track.id);
    return;
  }
  selectBlock(b.id);
  scrub(b.start / videoDuration);
  window.dispatchEvent(
    new CustomEvent('subifi:focus-block', {
      detail: { id: b.id },
    }),
  );
}}
```

The `scrub` function already exists in the component (line 219–223) and sets `video.currentTime`.

- [ ] Verify build: `npx tsc --noEmit`

### Step 2.2: Commit

```bash
git add components/Timeline.tsx
git commit -m "feat: click subtitle on timeline seeks video to its start"
```

---

## Task 3: Subtitle Overlap Prevention

**Files:**
- Modify: `lib/store.ts`
- Modify: `components/Timeline.tsx`
- Modify: `components/SubtitleList.tsx`

### Step 3.1: Add overlap clamping helper to `lib/store.ts`

- [ ] Add a helper function near the top of `store.ts` (after `syncBlocksToTrack`):

```typescript
// Clamp a block's start/end so it doesn't overlap its neighbors in the
// sorted block array. Returns the clamped start/end. A 10ms minimum gap
// prevents visually "touching" blocks from sharing a boundary and
// rendering simultaneously.
const MIN_GAP = 0.01; // 10ms

function clampToNeighbors(
  blocks: SubtitleBlock[],
  id: string,
  start: number,
  end: number,
): { start: number; end: number } {
  const idx = blocks.findIndex((b) => b.id === id);
  if (idx < 0) return { start, end };
  const prev = idx > 0 ? blocks[idx - 1] : null;
  const next = idx < blocks.length - 1 ? blocks[idx + 1] : null;
  let s = start;
  let e = end;
  if (prev && s < prev.end + MIN_GAP) s = prev.end + MIN_GAP;
  if (next && e > next.start - MIN_GAP) e = next.start - MIN_GAP;
  // Ensure the block still has positive duration after clamping
  if (e - s < 0.05) {
    // If clamping squeezed it too tight, prefer keeping it at its
    // original position clamped to neighbors rather than inverting.
    if (prev && next) {
      s = prev.end + MIN_GAP;
      e = next.start - MIN_GAP;
    }
  }
  return { start: s, end: e };
}
```

### Step 3.2: Apply overlap clamping in `updateBlock`

- [ ] In `store.ts`, modify the `updateBlock` action. Inside the `map` callback, after constructing `updated`, add clamping when start or end changed:

Replace the block-mapping logic:
```typescript
updateBlock: (id, patch) =>
  set((s) => {
    const newBlocks = s.blocks.map((b) => {
      if (b.id !== id) return b;
      const updated = { ...b, ...patch };
      if ('text' in patch && patch.text !== b.text && updated.words) {
        updated.words = undefined;
      }
      return updated;
    });
```

With:
```typescript
updateBlock: (id, patch) =>
  set((s) => {
    let newBlocks = s.blocks.map((b) => {
      if (b.id !== id) return b;
      const updated = { ...b, ...patch };
      if ('text' in patch && patch.text !== b.text && updated.words) {
        updated.words = undefined;
      }
      return updated;
    });
    // Prevent overlap when start/end changed
    if ('start' in patch || 'end' in patch) {
      const idx = newBlocks.findIndex((b) => b.id === id);
      if (idx >= 0) {
        const b = newBlocks[idx];
        const clamped = clampToNeighbors(newBlocks, id, b.start, b.end);
        if (clamped.start !== b.start || clamped.end !== b.end) {
          newBlocks = newBlocks.map((blk) =>
            blk.id === id ? { ...blk, start: clamped.start, end: clamped.end } : blk,
          );
        }
      }
    }
```

### Step 3.3: Remove duplicate overlap clamping from Timeline if needed

The Timeline's drag handler already snaps but doesn't hard-prevent overlap. Now that `updateBlock` does it, the timeline drags will automatically be clamped. No extra change needed in Timeline.tsx for blocks.

- [ ] Verify build: `npx tsc --noEmit`

### Step 3.4: Add overlap clamping to SubtitleList time inputs

- [ ] In `SubtitleList.tsx`, find the time inputs for block start/end. There are existing `<input type="number">` fields for start and end times. These call `updateBlock` which now clamps automatically. But we should also show visual feedback:

In the time input `onChange` handler, the clamping happens in the store. The inputs already read from block state so they'll reflect the clamped value. No additional UI change needed — the store handles it.

### Step 3.5: Commit

```bash
git add lib/store.ts
git commit -m "feat: prevent subtitle overlap within same track"
```

---

## Task 4: Expanded Per-Block Style Overrides

**Files:**
- Modify: `components/SubtitleList.tsx`

### Step 4.1: Expand the override panel

- [ ] In `SubtitleList.tsx`, add the `FontPicker` import at the top:

```typescript
import { GOOGLE_FONTS, loadGoogleFont } from '@/lib/google-fonts';
```

- [ ] Replace the override panel content (the `div` inside `{openOverrides[b.id] && (` block, lines 226–324). Expand it to include fontFamily, textOutlineColor, textOutlineWidth, backgroundColor, backgroundOpacity, maxWidth, letterSpacing alongside the existing fontSize, textColor, positionY, fontWeight:

```tsx
{openOverrides[b.id] && (
  <div className="mt-1 flex flex-wrap items-center gap-3 rounded border border-border bg-bg-hi/40 px-2 py-1.5 text-xs text-text-muted">
    {/* Font family */}
    <label className="flex items-center gap-1">
      <span>font</span>
      <select
        value={b.styleOverride?.fontFamily ?? globalStyle.fontFamily}
        onChange={(e) => {
          const family = e.target.value;
          if (GOOGLE_FONTS.includes(family)) loadGoogleFont(family, b.styleOverride?.fontWeight ?? globalStyle.fontWeight);
          updateBlock(b.id, {
            styleOverride: { ...b.styleOverride, fontFamily: family },
          });
        }}
        className="max-w-[120px] rounded bg-bg-hi px-1 py-0.5 text-text"
      >
        {GOOGLE_FONTS.map((f) => (
          <option key={f} value={f}>{f}</option>
        ))}
      </select>
    </label>
    {/* Font size */}
    <label className="flex items-center gap-1">
      <span>size</span>
      <input
        type="number"
        step={1}
        min={8}
        max={300}
        value={b.styleOverride?.fontSize ?? globalStyle.fontSize}
        onChange={(e) =>
          updateBlock(b.id, {
            styleOverride: { ...b.styleOverride, fontSize: Number(e.target.value) },
          })
        }
        className="w-14 rounded bg-bg-hi px-1 py-0.5 font-mono text-text"
      />
    </label>
    {/* Font weight */}
    <label className="flex items-center gap-1">
      <span>weight</span>
      <input
        type="number"
        step={100}
        min={100}
        max={900}
        value={b.styleOverride?.fontWeight ?? globalStyle.fontWeight}
        onChange={(e) =>
          updateBlock(b.id, {
            styleOverride: { ...b.styleOverride, fontWeight: Number(e.target.value) },
          })
        }
        className="w-14 rounded bg-bg-hi px-1 py-0.5 font-mono text-text"
      />
    </label>
    {/* Text color */}
    <label className="flex items-center gap-1">
      <span>color</span>
      <input
        type="color"
        value={b.styleOverride?.textColor ?? globalStyle.textColor}
        onChange={(e) =>
          updateBlock(b.id, {
            styleOverride: { ...b.styleOverride, textColor: e.target.value },
          })
        }
      />
    </label>
    {/* Outline color */}
    <label className="flex items-center gap-1">
      <span>outline</span>
      <input
        type="color"
        value={b.styleOverride?.textOutlineColor ?? globalStyle.textOutlineColor}
        onChange={(e) =>
          updateBlock(b.id, {
            styleOverride: { ...b.styleOverride, textOutlineColor: e.target.value },
          })
        }
      />
    </label>
    {/* Outline width */}
    <label className="flex items-center gap-1">
      <span>outline W</span>
      <input
        type="number"
        step={0.5}
        min={0}
        max={20}
        value={b.styleOverride?.textOutlineWidth ?? globalStyle.textOutlineWidth}
        onChange={(e) =>
          updateBlock(b.id, {
            styleOverride: { ...b.styleOverride, textOutlineWidth: Number(e.target.value) },
          })
        }
        className="w-14 rounded bg-bg-hi px-1 py-0.5 font-mono text-text"
      />
    </label>
    {/* Background color */}
    <label className="flex items-center gap-1">
      <span>bg</span>
      <input
        type="color"
        value={b.styleOverride?.backgroundColor ?? globalStyle.backgroundColor}
        onChange={(e) =>
          updateBlock(b.id, {
            styleOverride: { ...b.styleOverride, backgroundColor: e.target.value },
          })
        }
      />
    </label>
    {/* Background opacity */}
    <label className="flex items-center gap-1">
      <span>bg %</span>
      <input
        type="number"
        step={5}
        min={0}
        max={100}
        value={Math.round((b.styleOverride?.backgroundOpacity ?? globalStyle.backgroundOpacity) * 100)}
        onChange={(e) =>
          updateBlock(b.id, {
            styleOverride: { ...b.styleOverride, backgroundOpacity: Number(e.target.value) / 100 },
          })
        }
        className="w-14 rounded bg-bg-hi px-1 py-0.5 font-mono text-text"
      />
    </label>
    {/* Y position */}
    <label className="flex items-center gap-1">
      <span>Y%</span>
      <input
        type="number"
        step={1}
        min={0}
        max={100}
        value={Math.round((b.styleOverride?.positionY ?? globalStyle.positionY) * 100)}
        onChange={(e) =>
          updateBlock(b.id, {
            styleOverride: { ...b.styleOverride, positionY: Number(e.target.value) / 100 },
          })
        }
        className="w-14 rounded bg-bg-hi px-1 py-0.5 font-mono text-text"
      />
    </label>
    {/* Max width */}
    <label className="flex items-center gap-1">
      <span>width%</span>
      <input
        type="number"
        step={5}
        min={10}
        max={100}
        value={Math.round((b.styleOverride?.maxWidth ?? globalStyle.maxWidth) * 100)}
        onChange={(e) =>
          updateBlock(b.id, {
            styleOverride: { ...b.styleOverride, maxWidth: Number(e.target.value) / 100 },
          })
        }
        className="w-14 rounded bg-bg-hi px-1 py-0.5 font-mono text-text"
      />
    </label>
    {/* Letter spacing */}
    <label className="flex items-center gap-1">
      <span>spacing</span>
      <input
        type="number"
        step={0.5}
        min={-10}
        max={30}
        value={b.styleOverride?.letterSpacing ?? globalStyle.letterSpacing}
        onChange={(e) =>
          updateBlock(b.id, {
            styleOverride: { ...b.styleOverride, letterSpacing: Number(e.target.value) },
          })
        }
        className="w-14 rounded bg-bg-hi px-1 py-0.5 font-mono text-text"
      />
    </label>
    {/* Reset button */}
    {b.styleOverride && Object.keys(b.styleOverride).length > 0 && (
      <button
        type="button"
        onClick={() => updateBlock(b.id, { styleOverride: undefined })}
        className="ml-auto rounded border border-border px-2 py-0.5 text-text-muted hover:border-accent hover:text-text"
        title="Reset this block to the global style"
      >
        reset
      </button>
    )}
  </div>
)}
```

- [ ] Verify build: `npx tsc --noEmit`

### Step 4.2: Commit

```bash
git add components/SubtitleList.tsx
git commit -m "feat: expand per-subtitle style overrides (font, outline, bg, spacing, width)"
```

---

## Task 5: Project Export/Import

**Files:**
- Create: `lib/project-file.ts`
- Modify: `components/ExportBar.tsx`
- Modify: `lib/store.ts` (add `importProject` action)

### Step 5.1: Create `lib/project-file.ts`

- [ ] Create the serialization module:

```typescript
// lib/project-file.ts
// Serialize / deserialize full project state to a portable JSON file.
// The video and extracted audio are NOT included (too large) — the user
// must have the video loaded separately. Everything else round-trips:
// blocks, tracks, style, overlays, text overlays, cuts, safe zone,
// segmentation config, and custom fonts (base64-embedded).

import type {
  Cut,
  CustomFont,
  ImageOverlay,
  SafeZone,
  SegmentationConfig,
  Style,
  SubtitleBlock,
  SubtitleTrack,
  TextOverlay,
  Word,
} from './types';

const FORMAT_VERSION = 1;

// The portable shape — no File, no Uint8Array, no ArrayBuffer. Custom
// fonts carry their dataUrl (already base64) so they survive JSON.
export type ProjectFile = {
  _format: 'subifi-project';
  _version: typeof FORMAT_VERSION;
  exportedAt: string; // ISO 8601
  style: Style;
  segmentation: SegmentationConfig;
  blocks: SubtitleBlock[];
  subtitleTracks: SubtitleTrack[];
  activeTrackId: string;
  words: Word[];
  textOverlays: TextOverlay[];
  imageOverlays: Array<Omit<ImageOverlay, 'dataUrl'> & { dataUrl: string }>;
  cuts: Cut[];
  safeZone: SafeZone;
  customFonts: Array<{ name: string; dataUrl: string; format: CustomFont['format'] }>;
};

export function exportProject(state: {
  style: Style;
  segmentation: SegmentationConfig;
  blocks: SubtitleBlock[];
  subtitleTracks: SubtitleTrack[];
  activeTrackId: string;
  words: Word[];
  textOverlays: TextOverlay[];
  overlays: ImageOverlay[];
  cuts: Cut[];
  safeZone: SafeZone;
  customFonts: CustomFont[];
}): string {
  const file: ProjectFile = {
    _format: 'subifi-project',
    _version: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    style: state.style,
    segmentation: state.segmentation,
    blocks: state.blocks,
    subtitleTracks: state.subtitleTracks,
    activeTrackId: state.activeTrackId,
    words: state.words,
    textOverlays: state.textOverlays,
    imageOverlays: state.overlays.map((o) => ({
      ...o,
      // dataUrl is already a base64 data URL from the image upload flow
    })),
    cuts: state.cuts,
    safeZone: state.safeZone,
    customFonts: state.customFonts.map((f) => ({
      name: f.name,
      dataUrl: f.dataUrl,
      format: f.format,
    })),
  };
  return JSON.stringify(file, null, 2);
}

export function parseProjectFile(json: string): ProjectFile {
  const parsed = JSON.parse(json) as unknown;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as Record<string, unknown>)._format !== 'subifi-project'
  ) {
    throw new Error('Not a valid SubIFI project file');
  }
  return parsed as ProjectFile;
}
```

### Step 5.2: Add `importProject` action to `lib/store.ts`

- [ ] Add `importProject` to the `EditorActions` type:

```typescript
importProject: (project: {
  style: Style;
  segmentation: SegmentationConfig;
  blocks: SubtitleBlock[];
  subtitleTracks: SubtitleTrack[];
  activeTrackId: string;
  words: Word[];
  textOverlays: TextOverlay[];
  imageOverlays: ImageOverlay[];
  cuts: Cut[];
  safeZone: SafeZone;
  customFonts: Array<{ name: string; dataUrl: string; format: CustomFont['format'] }>;
}) => void;
```

- [ ] Add the implementation in the store body:

```typescript
importProject: (project) =>
  set((s) => ({
    ...pushHistory(s),
    style: { ...DEFAULT_STYLE, ...project.style },
    segmentation: project.segmentation,
    blocks: project.blocks,
    subtitleTracks: project.subtitleTracks,
    activeTrackId: project.activeTrackId,
    words: project.words,
    textOverlays: project.textOverlays,
    overlays: project.imageOverlays,
    cuts: project.cuts,
    safeZone: project.safeZone,
    customFonts: project.customFonts.map((f) => ({
      ...f,
      // Reconstruct the ArrayBuffer from the base64 dataUrl for burn-in.
      buffer: base64ToBuffer(f.dataUrl),
    })),
    selectedBlockId: null,
    selectedOverlayId: null,
    selectedTextOverlayId: null,
    status: project.blocks.length > 0 ? 'ready' as const : s.status,
  })),
```

- [ ] Add the `base64ToBuffer` helper at the top of `store.ts`:

```typescript
function base64ToBuffer(dataUrl: string): ArrayBuffer {
  const base64 = dataUrl.split(',')[1] ?? '';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
```

### Step 5.3: Add project export/import buttons to `ExportBar.tsx`

- [ ] In `ExportBar.tsx`, add imports:

```typescript
import { useRef } from 'react';
import { exportProject, parseProjectFile } from '@/lib/project-file';
```

- [ ] Update the useEditor destructuring to add the fields needed:

```typescript
const {
  blocks, videoFile, style, segmentation, subtitleTracks, activeTrackId,
  words, textOverlays, overlays, cuts, safeZone, customFonts, importProject,
} = useEditor();
```

- [ ] Add a file input ref and handler:

```typescript
const projectInputRef = useRef<HTMLInputElement>(null);

const onImportProject = async (file: File) => {
  try {
    const json = await file.text();
    const project = parseProjectFile(json);
    importProject({
      style: project.style,
      segmentation: project.segmentation,
      blocks: project.blocks,
      subtitleTracks: project.subtitleTracks,
      activeTrackId: project.activeTrackId,
      words: project.words,
      textOverlays: project.textOverlays,
      imageOverlays: project.imageOverlays,
      cuts: project.cuts,
      safeZone: project.safeZone,
      customFonts: project.customFonts,
    });
  } catch (err) {
    alert(`Import failed: ${err instanceof Error ? err.message : 'Invalid file'}`);
  }
};
```

- [ ] Add the export and import buttons after the existing JSON button:

```tsx
<Button
  variant="secondary"
  size="sm"
  disabled={disabled}
  className="shrink-0"
  onClick={() => {
    const json = exportProject({
      style, segmentation, blocks, subtitleTracks, activeTrackId,
      words, textOverlays, overlays, cuts, safeZone, customFonts,
    });
    downloadBlob(json, `${baseName}.subifi.json`, 'application/json');
  }}
>
  Project
</Button>
<Button
  variant="secondary"
  size="sm"
  className="shrink-0"
  onClick={() => projectInputRef.current?.click()}
>
  Import
</Button>
<input
  ref={projectInputRef}
  type="file"
  accept=".json,.subifi.json"
  className="hidden"
  onChange={(e) => {
    const file = e.target.files?.[0];
    if (file) void onImportProject(file);
    e.target.value = '';
  }}
/>
```

- [ ] Verify build: `npx tsc --noEmit`

### Step 5.4: Commit

```bash
git add lib/project-file.ts lib/store.ts components/ExportBar.tsx
git commit -m "feat: project export/import as .subifi.json files"
```

---

## Task 6: Style Preset Export/Import

**Files:**
- Create: `lib/style-file.ts`
- Modify: `components/PresetsBar.tsx`

### Step 6.1: Create `lib/style-file.ts`

- [ ] Create the style preset serialization module:

```typescript
// lib/style-file.ts
// Export/import user style presets as portable JSON files.

import type { Style } from './types';
import type { UserStylePreset } from './user-presets';

const FORMAT_VERSION = 1;

type StyleFileEntry = {
  label: string;
  style: Style;
};

type StyleFile = {
  _format: 'subifi-styles';
  _version: typeof FORMAT_VERSION;
  exportedAt: string;
  presets: StyleFileEntry[];
};

export function exportStyles(presets: UserStylePreset[]): string {
  const file: StyleFile = {
    _format: 'subifi-styles',
    _version: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    presets: presets.map((p) => ({ label: p.label, style: p.style })),
  };
  return JSON.stringify(file, null, 2);
}

export function parseStyleFile(json: string): StyleFileEntry[] {
  const parsed = JSON.parse(json) as unknown;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as Record<string, unknown>)._format !== 'subifi-styles'
  ) {
    throw new Error('Not a valid SubIFI style file');
  }
  const file = parsed as StyleFile;
  if (!Array.isArray(file.presets)) {
    throw new Error('No presets found in file');
  }
  return file.presets;
}
```

### Step 6.2: Add export/import to `PresetsBar.tsx`

- [ ] Add imports:

```typescript
import { useRef } from 'react';
import { exportStyles, parseStyleFile } from '@/lib/style-file';
import { downloadBlob } from '@/lib/download';
```

Change `import { useEffect, useState } from 'react';` to `import { useEffect, useRef, useState } from 'react';`.

- [ ] Add a file input ref and import handler inside the component:

```typescript
const styleInputRef = useRef<HTMLInputElement>(null);

const onImportStyles = async (file: File) => {
  try {
    const json = await file.text();
    const entries = parseStyleFile(json);
    for (const entry of entries) {
      addUserPreset(entry.label, entry.style);
    }
    setUserPresets(loadUserPresets());
  } catch (err) {
    alert(`Import failed: ${err instanceof Error ? err.message : 'Invalid file'}`);
  }
};
```

- [ ] Add export/import buttons after the existing "+ Save" button:

```tsx
<Button
  variant="ghost"
  size="sm"
  className="shrink-0"
  onClick={() => {
    if (userPresets.length === 0) {
      alert('No saved presets to export.');
      return;
    }
    const json = exportStyles(userPresets);
    downloadBlob(json, 'styles.subifi-styles.json', 'application/json');
  }}
  title="Export all saved presets as a file"
  disabled={userPresets.length === 0}
>
  Export
</Button>
<Button
  variant="ghost"
  size="sm"
  className="shrink-0"
  onClick={() => styleInputRef.current?.click()}
  title="Import presets from a file"
>
  Import
</Button>
<input
  ref={styleInputRef}
  type="file"
  accept=".json"
  className="hidden"
  onChange={(e) => {
    const file = e.target.files?.[0];
    if (file) void onImportStyles(file);
    e.target.value = '';
  }}
/>
```

- [ ] Verify build: `npx tsc --noEmit`

### Step 6.3: Commit

```bash
git add lib/style-file.ts components/PresetsBar.tsx
git commit -m "feat: style preset export/import as shareable files"
```

---

## Task 7: Final Verification

- [ ] Run full build: `npx next build` or `npx tsc --noEmit`
- [ ] Manual test checklist:
  - [ ] Drag a subtitle in preview — cyan snap guides appear at center and near other elements
  - [ ] Click a subtitle block on the timeline — video seeks to its start time
  - [ ] Drag a block in timeline to overlap a neighbor — it gets clamped
  - [ ] Open the 🎨 override panel — all new fields are present and functional
  - [ ] Export project as .subifi.json — file downloads with full state
  - [ ] Import project from .subifi.json — state restores correctly
  - [ ] Save a style preset, export styles, import into a fresh session
- [ ] Final commit if any fixes needed
