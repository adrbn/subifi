// Helpers for working with the user-defined `Cut[]` (segments removed from
// the source at burn time). Cuts are stored in original-video time; this
// module is the single source of truth for converting between original time
// and post-cut ("kept") time so the burn pipeline and any UI showing the
// trimmed duration agree on the math.

import type { Cut, ImageOverlay, SubtitleBlock, TextOverlay } from './types';

export type TimeRange = { start: number; end: number };

// Returns cuts sorted by start, clamped to [0, duration], with overlapping
// or touching ranges merged. Empty ranges (end<=start) are dropped. The
// result is suitable for any of the helpers below.
export function normalizeCuts(cuts: Cut[], duration: number): Cut[] {
  if (cuts.length === 0 || duration <= 0) return [];
  const clamped = cuts
    .map((c) => ({
      id: c.id,
      start: Math.max(0, Math.min(duration, c.start)),
      end: Math.max(0, Math.min(duration, c.end)),
    }))
    .filter((c) => c.end > c.start);
  clamped.sort((a, b) => a.start - b.start);
  const merged: Cut[] = [];
  for (const c of clamped) {
    const last = merged[merged.length - 1];
    if (last && c.start <= last.end) {
      // Extend the previous cut to cover this one. We keep the earlier id
      // so callers that map cuts back to UI handles still find them.
      if (c.end > last.end) last.end = c.end;
    } else {
      merged.push({ ...c });
    }
  }
  return merged;
}

// Inverse of cuts: the ranges that survive in the exported video, in
// original-video time. Adjacent keep-ranges always have a cut between them.
export function getKeepRanges(cuts: Cut[], duration: number): TimeRange[] {
  if (duration <= 0) return [];
  const norm = normalizeCuts(cuts, duration);
  if (norm.length === 0) return [{ start: 0, end: duration }];
  const out: TimeRange[] = [];
  let cursor = 0;
  for (const c of norm) {
    if (c.start > cursor) out.push({ start: cursor, end: c.start });
    cursor = c.end;
  }
  if (cursor < duration) out.push({ start: cursor, end: duration });
  return out;
}

// Total duration removed by the cuts that come before (or contain) `t`.
// If `t` falls inside a cut, the *full* cut counts — the caller is expected
// to first call `isInsideCut` if it cares about that distinction.
function totalCutBefore(t: number, cuts: Cut[]): number {
  let removed = 0;
  for (const c of cuts) {
    if (c.end <= t) {
      removed += c.end - c.start;
    } else if (c.start < t && c.end > t) {
      // Inside a cut — count the part of the cut that comes before t.
      removed += t - c.start;
      break;
    } else {
      break;
    }
  }
  return removed;
}

// Returns the post-cut time corresponding to an original-video time, or
// `null` if `t` falls strictly inside a cut. Use this for clamping subtitle
// boundaries to the kept timeline.
export function remapTime(
  t: number,
  cuts: Cut[],
  duration: number,
): number | null {
  const norm = normalizeCuts(cuts, duration);
  for (const c of norm) {
    if (t > c.start && t < c.end) return null;
  }
  return Math.max(0, t - totalCutBefore(t, norm));
}

// Final duration of the exported video after all cuts have been removed.
export function effectiveDuration(cuts: Cut[], duration: number): number {
  const norm = normalizeCuts(cuts, duration);
  let removed = 0;
  for (const c of norm) removed += c.end - c.start;
  return Math.max(0, duration - removed);
}

// Generic block remapper: clips each block to the keep-ranges, drops
// anything that lies entirely inside a cut, and shifts what survives onto
// the post-cut timeline. The id is preserved when only one fragment
// remains; if a single block straddles multiple keep-ranges it gets split
// into multiple fragments with fresh ids so each piece can be addressed
// independently in the burn output.
//
// Used for both SubtitleBlock and TextOverlay — shapes share the
// {id, start, end} subset and the function is generic over the rest.
function remapBlocks<T extends { id: string; start: number; end: number }>(
  items: T[],
  cuts: Cut[],
  duration: number,
): T[] {
  const keeps = getKeepRanges(cuts, duration);
  if (keeps.length === 1 && keeps[0].start === 0 && keeps[0].end === duration) {
    return items;
  }
  const out: T[] = [];
  for (const item of items) {
    let firstFragment = true;
    for (const k of keeps) {
      const overlapStart = Math.max(item.start, k.start);
      const overlapEnd = Math.min(item.end, k.end);
      if (overlapEnd <= overlapStart) continue;
      // Map both ends through remapTime — they're guaranteed to be inside
      // a keep-range here so the result is never null.
      const mappedStart = remapTime(overlapStart, cuts, duration) ?? 0;
      const mappedEnd = remapTime(overlapEnd, cuts, duration) ?? 0;
      if (mappedEnd <= mappedStart) continue;
      out.push({
        ...item,
        // Keep the original id for the first surviving fragment so the
        // user's selection (if any) doesn't get orphaned. Subsequent
        // fragments get fresh ids.
        id: firstFragment ? item.id : Math.random().toString(36).slice(2, 10),
        start: mappedStart,
        end: mappedEnd,
      });
      firstFragment = false;
    }
  }
  return out;
}

export function remapSubtitleBlocks(
  blocks: SubtitleBlock[],
  cuts: Cut[],
  duration: number,
): SubtitleBlock[] {
  // Per-word timings would also need to be re-mapped to be useful for
  // karaoke after a cut. We strip them when a block survives a cut so the
  // ASS generator falls back to the plain-text path — accurate karaoke
  // across cut boundaries is out of scope for the MVP.
  const keeps = getKeepRanges(cuts, duration);
  const noCuts =
    keeps.length === 1 && keeps[0].start === 0 && keeps[0].end === duration;
  if (noCuts) return blocks;
  return remapBlocks(blocks, cuts, duration).map((b) => ({
    ...b,
    words: undefined,
  }));
}

export function remapTextOverlays(
  textOverlays: TextOverlay[],
  cuts: Cut[],
  duration: number,
): TextOverlay[] {
  return remapBlocks(textOverlays, cuts, duration);
}

export function remapImageOverlays(
  overlays: ImageOverlay[],
  cuts: Cut[],
  duration: number,
): ImageOverlay[] {
  return remapBlocks(overlays, cuts, duration);
}
