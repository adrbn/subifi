import { create } from 'zustand';
import type {
  Cut,
  CustomFont,
  ImageOverlay,
  SafeZone,
  SafeZonePreset,
  SegmentationConfig,
  Status,
  Style,
  SubtitleBlock,
  SubtitleTrack,
  TextOverlay,
  Word,
} from './types';
import {
  DEFAULT_OVERLAYS,
  DEFAULT_SAFE_ZONE,
  DEFAULT_SEGMENTATION,
  DEFAULT_STYLE,
  SAFE_ZONE_PRESETS,
} from './presets';
import { segmentWords, wordsFromBlocks } from './segmenter';
import type { SessionSnapshot } from './persist';

// Snapshot of all "editable" state — what undo/redo flips between. Runtime
// fields like videoUrl, status, currentTime are NOT here on purpose: they
// represent ephemeral playback / pipeline state, not user intent.
type HistorySnapshot = {
  blocks: SubtitleBlock[];
  subtitleTracks: SubtitleTrack[];
  activeTrackId: string;
  textOverlays: TextOverlay[];
  overlays: ImageOverlay[];
  style: Style;
  segmentation: SegmentationConfig;
  safeZone: SafeZone;
  cuts: Cut[];
};

export type EditorState = {
  // Video
  videoFile: File | null;
  videoUrl: string | null;
  videoDuration: number;
  videoWidth: number;
  videoHeight: number;

  // Audio extracted from the video, kept in memory so the user can trigger
  // transcription explicitly after dropping the video.
  extractedAudio: Uint8Array | null;

  // Transcription / blocks
  words: Word[];
  // `blocks` is always the active track's blocks. Kept at top level so
  // existing components (SubtitleList, Timeline, etc.) keep working without
  // refactoring. Mutations via updateBlock/splitBlock/etc. update the active
  // track automatically.
  blocks: SubtitleBlock[];
  // Multi-track: each track is an independent subtitle layer (original,
  // translations, etc.). The first track is always the "Original".
  subtitleTracks: SubtitleTrack[];
  activeTrackId: string;
  // Currently "focused" subtitle block. Used by the SubtitleList, Timeline
  // and VideoPreview to highlight the same row from any angle — clicking a
  // block in any surface selects it in all three. Purely UI state, not
  // persisted and not part of undo history.
  selectedBlockId: string | null;

  // Styling
  style: Style;
  segmentation: SegmentationConfig;
  customFonts: CustomFont[];
  overlays: ImageOverlay[];
  selectedOverlayId: string | null;
  textOverlays: TextOverlay[];
  selectedTextOverlayId: string | null;
  safeZone: SafeZone;

  // Cuts — segments removed from the source at burn time. Stored in
  // original-video time. See lib/cuts.ts for the math that turns these
  // into post-cut keep-ranges and remaps subtitle/text overlay timings.
  cuts: Cut[];

  // Runtime
  status: Status;
  error: string | null;
  progress: number; // 0..1, used for extraction / burning
  currentTime: number; // playback position in seconds

  // Undo/redo history. `past` is oldest→newest of pre-mutation snapshots;
  // `future` is what undo has popped off and could be re-applied by redo.
  past: HistorySnapshot[];
  future: HistorySnapshot[];
  lastHistoryAt: number; // ms timestamp of the last push, for coalescing

  // Ephemeral label shown after undo/redo — auto-clears after a few seconds.
  undoRedoLabel: string | null;
};

const HISTORY_LIMIT = 50;

// Describe what changed between two history snapshots.
function describeChange(before: HistorySnapshot, after: HistorySnapshot): string {
  if (before.blocks.length !== after.blocks.length) {
    const d = after.blocks.length - before.blocks.length;
    return d > 0 ? `+${d} subtitle(s)` : `${d} subtitle(s)`;
  }
  if (before.textOverlays.length !== after.textOverlays.length) {
    const d = after.textOverlays.length - before.textOverlays.length;
    return d > 0 ? `+${d} text overlay(s)` : `${d} text overlay(s)`;
  }
  if (before.overlays.length !== after.overlays.length) {
    const d = after.overlays.length - before.overlays.length;
    return d > 0 ? `+${d} image(s)` : `${d} image(s)`;
  }
  if (before.cuts.length !== after.cuts.length) {
    const d = after.cuts.length - before.cuts.length;
    return d > 0 ? `+${d} cut(s)` : `${d} cut(s)`;
  }
  if (before.style !== after.style) return 'style change';
  if (before.blocks !== after.blocks) return 'subtitle edit';
  if (before.textOverlays !== after.textOverlays) return 'text overlay edit';
  if (before.overlays !== after.overlays) return 'image edit';
  return 'edit';
}
// Window during which a follow-up mutation gets coalesced into the previous
// undo entry — fast enough that intentional clicks stay separate, slow
// enough that slider/trim drags fold into a single Cmd+Z step.
const HISTORY_COALESCE_MS = 350;

const DEFAULT_TRACK_ID = 'original';

const snap = (s: EditorState): HistorySnapshot => ({
  blocks: s.blocks,
  subtitleTracks: s.subtitleTracks,
  activeTrackId: s.activeTrackId,
  textOverlays: s.textOverlays,
  overlays: s.overlays,
  style: s.style,
  segmentation: s.segmentation,
  safeZone: s.safeZone,
  cuts: s.cuts,
});

// Sync `blocks` into the active track within `subtitleTracks`.
function syncBlocksToTrack(
  tracks: SubtitleTrack[],
  activeTrackId: string,
  blocks: SubtitleBlock[],
): SubtitleTrack[] {
  return tracks.map((t) =>
    t.id === activeTrackId ? { ...t, blocks } : t,
  );
}

// Returns the patch to merge into a `set()` so that this mutation becomes
// undoable. Coalesces with the previous push if it happened very recently.
const pushHistory = (
  s: EditorState,
): Pick<EditorState, 'past' | 'future' | 'lastHistoryAt'> => {
  const now = Date.now();
  if (now - s.lastHistoryAt < HISTORY_COALESCE_MS && s.past.length > 0) {
    // Same gesture — keep the existing snapshot (which captures the state
    // *before* the gesture started), reset the future stack.
    return { past: s.past, future: [], lastHistoryAt: now };
  }
  const past = [...s.past, snap(s)].slice(-HISTORY_LIMIT);
  return { past, future: [], lastHistoryAt: now };
};

export type EditorActions = {
  setVideo: (
    file: File,
    url: string,
    duration: number,
    width: number,
    height: number,
  ) => void;
  clearVideo: () => void;
  setExtractedAudio: (audio: Uint8Array | null) => void;
  setBlocks: (blocks: SubtitleBlock[]) => void;
  setWords: (words: Word[]) => void;
  resegment: (cfg?: Partial<SegmentationConfig>) => void;
  updateBlock: (id: string, patch: Partial<SubtitleBlock>) => void;
  splitBlockAt: (id: string, charIndex: number) => void;
  mergeWithNext: (id: string) => void;
  deleteBlock: (id: string) => void;
  selectBlock: (id: string | null) => void;
  setStyle: (patch: Partial<Style>) => void;
  applyStylePreset: (style: Style) => void;
  addCustomFont: (font: CustomFont) => void;
  // `start`/`end` default to "spans the whole video" if omitted, so most
  // call sites just pass the visual fields (dataUrl/positionX/etc.).
  addOverlay: (
    overlay: Omit<ImageOverlay, 'id' | 'start' | 'end'> &
      Partial<Pick<ImageOverlay, 'start' | 'end'>>,
  ) => string;
  removeOverlay: (id: string) => void;
  updateOverlay: (id: string, patch: Partial<ImageOverlay>) => void;
  selectOverlay: (id: string | null) => void;
  addTextOverlay: (overlay?: Partial<Omit<TextOverlay, 'id'>>) => string;
  removeTextOverlay: (id: string) => void;
  updateTextOverlay: (id: string, patch: Partial<TextOverlay>) => void;
  selectTextOverlay: (id: string | null) => void;
  setSafeZonePreset: (preset: SafeZonePreset) => void;
  // Subtitle tracks — multi-layer subtitle management.
  addSubtitleTrack: (label: string, blocks: SubtitleBlock[]) => string;
  removeSubtitleTrack: (id: string) => void;
  setActiveTrack: (id: string) => void;
  toggleTrackVisibility: (id: string) => void;
  // Toggle visibility of text overlays / image overlays / cuts in bulk.
  // These flags are stored as simple booleans on the store for simplicity.
  textOverlaysVisible: boolean;
  imageOverlaysVisible: boolean;
  cutsVisible: boolean;
  toggleTextOverlaysVisible: () => void;
  toggleImageOverlaysVisible: () => void;
  toggleCutsVisible: () => void;
  // Split the currently selected element (block, text overlay, or image
  // overlay) at the playhead into two pieces. No-ops if nothing is
  // selected or the playhead is outside the element's range.
  splitSelectedAtPlayhead: () => void;
  // Cuts. addCut creates a new cut centred on the current playhead and
  // returns its id so callers (e.g. the timeline) can immediately select
  // / drag it. Default duration is 1 second, clamped to the video.
  addCut: (cut?: Partial<Omit<Cut, 'id'>>) => string;
  updateCut: (id: string, patch: Partial<Cut>) => void;
  removeCut: (id: string) => void;
  clearCuts: () => void;
  // Returns all blocks from visible subtitle tracks, concatenated.
  visibleBlocks: () => SubtitleBlock[];
  setStatus: (status: Status, error?: string | null) => void;
  setProgress: (progress: number) => void;
  setCurrentTime: (t: number) => void;
  // Undo / redo. Both no-op when their stack is empty.
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  // Rehydrate the editor from a previously persisted session (see
  // lib/persist.ts). Recreates a fresh blob URL from the stored File and
  // infers a sensible starting `status` from what was saved.
  hydrate: (snapshot: SessionSnapshot) => void;
};

export const useEditor = create<EditorState & EditorActions>()((set, get) => ({
  videoFile: null,
  videoUrl: null,
  videoDuration: 0,
  videoWidth: 1920,
  videoHeight: 1080,

  extractedAudio: null,

  words: [],
  blocks: [],
  subtitleTracks: [
    { id: DEFAULT_TRACK_ID, label: 'Original', visible: true, blocks: [] },
  ],
  activeTrackId: DEFAULT_TRACK_ID,
  selectedBlockId: null,

  style: DEFAULT_STYLE,
  segmentation: DEFAULT_SEGMENTATION,
  customFonts: [],
  overlays: DEFAULT_OVERLAYS,
  selectedOverlayId: null,
  textOverlays: [],
  selectedTextOverlayId: null,
  safeZone: DEFAULT_SAFE_ZONE,

  cuts: [],

  textOverlaysVisible: true,
  imageOverlaysVisible: true,
  cutsVisible: true,

  status: 'idle',
  error: null,
  progress: 0,
  currentTime: 0,

  past: [],
  future: [],
  lastHistoryAt: 0,
  undoRedoLabel: null,

  setVideo: (file, url, duration, width, height) =>
    set({
      videoFile: file,
      videoUrl: url,
      videoDuration: duration,
      videoWidth: width,
      videoHeight: height,
      extractedAudio: null,
      words: [],
      blocks: [],
      subtitleTracks: [
        { id: DEFAULT_TRACK_ID, label: 'Original', visible: true, blocks: [] },
      ],
      activeTrackId: DEFAULT_TRACK_ID,
      selectedBlockId: null,
      textOverlays: [],
      selectedTextOverlayId: null,
      cuts: [],
      status: 'idle',
      error: null,
      progress: 0,
      currentTime: 0,
      past: [],
      future: [],
      lastHistoryAt: 0,
    }),

  clearVideo: () => {
    const s = get();
    if (s.videoUrl) URL.revokeObjectURL(s.videoUrl);
    set({
      videoFile: null,
      videoUrl: null,
      videoDuration: 0,
      extractedAudio: null,
      words: [],
      blocks: [],
      subtitleTracks: [
        { id: DEFAULT_TRACK_ID, label: 'Original', visible: true, blocks: [] },
      ],
      activeTrackId: DEFAULT_TRACK_ID,
      selectedBlockId: null,
      overlays: [],
      selectedOverlayId: null,
      textOverlays: [],
      selectedTextOverlayId: null,
      cuts: [],
      status: 'idle',
      error: null,
      progress: 0,
      currentTime: 0,
      past: [],
      future: [],
      lastHistoryAt: 0,
    });
  },

  setExtractedAudio: (audio) => set({ extractedAudio: audio }),

  setBlocks: (blocks) =>
    // Fresh transcription / external load — wipe history. Undoing back to
    // an empty editor isn't useful and would just confuse the user.
    set((s) => ({
      blocks,
      subtitleTracks: syncBlocksToTrack(s.subtitleTracks, s.activeTrackId, blocks),
      selectedBlockId: null,
      status: 'ready',
      past: [],
      future: [],
      lastHistoryAt: 0,
    })),

  setWords: (words) => {
    const s = get();
    const blocks = segmentWords(words, s.segmentation);
    set({
      words,
      blocks,
      subtitleTracks: syncBlocksToTrack(s.subtitleTracks, s.activeTrackId, blocks),
      selectedBlockId: null,
      status: 'ready',
      past: [],
      future: [],
      lastHistoryAt: 0,
    });
  },

  resegment: (cfg) =>
    set((s) => {
      const next = { ...s.segmentation, ...(cfg ?? {}) };
      const sourceWords =
        s.blocks.length > 0 ? wordsFromBlocks(s.blocks) : s.words;
      const newBlocks = segmentWords(sourceWords, next);
      return {
        ...pushHistory(s),
        segmentation: next,
        blocks: newBlocks,
        subtitleTracks: syncBlocksToTrack(s.subtitleTracks, s.activeTrackId, newBlocks),
      };
    }),

  updateBlock: (id, patch) =>
    set((s) => {
      const newBlocks = s.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b));
      return {
        ...pushHistory(s),
        blocks: newBlocks,
        subtitleTracks: syncBlocksToTrack(s.subtitleTracks, s.activeTrackId, newBlocks),
      };
    }),

  splitBlockAt: (id, charIndex) =>
    set((s) => {
      const idx = s.blocks.findIndex((b) => b.id === id);
      if (idx < 0) return s;
      const b = s.blocks[idx];
      const left = b.text.slice(0, charIndex).replace(/\s+$/, '');
      const right = b.text.slice(charIndex).replace(/^\s+/, '');
      if (!left || !right) return s;

      let mid = b.start + (b.end - b.start) * (charIndex / b.text.length);
      let leftWords: Word[] | undefined;
      let rightWords: Word[] | undefined;
      if (b.words && b.words.length > 0) {
        let running = 0;
        let splitWordIdx = 0;
        for (let i = 0; i < b.words.length; i++) {
          const wLen = b.words[i].text.length + (i > 0 ? 1 : 0);
          if (running + wLen >= charIndex) {
            splitWordIdx = i;
            break;
          }
          running += wLen;
          splitWordIdx = i + 1;
        }
        if (splitWordIdx > 0 && splitWordIdx < b.words.length) {
          mid = b.words[splitWordIdx].start;
          leftWords = b.words.slice(0, splitWordIdx);
          rightWords = b.words.slice(splitWordIdx);
        }
      }

      const a: SubtitleBlock = {
        id: Math.random().toString(36).slice(2, 10),
        start: b.start,
        end: mid,
        text: left,
        words: leftWords,
      };
      const c: SubtitleBlock = {
        id: Math.random().toString(36).slice(2, 10),
        start: mid,
        end: b.end,
        text: right,
        words: rightWords,
      };
      const newBlocks = [...s.blocks.slice(0, idx), a, c, ...s.blocks.slice(idx + 1)];
      return {
        ...pushHistory(s),
        blocks: newBlocks,
        subtitleTracks: syncBlocksToTrack(s.subtitleTracks, s.activeTrackId, newBlocks),
      };
    }),

  mergeWithNext: (id) =>
    set((s) => {
      const idx = s.blocks.findIndex((b) => b.id === id);
      if (idx < 0 || idx === s.blocks.length - 1) return s;
      const a = s.blocks[idx];
      const b = s.blocks[idx + 1];
      const merged: SubtitleBlock = {
        id: a.id,
        start: a.start,
        end: b.end,
        text: `${a.text} ${b.text}`.trim(),
      };
      const newBlocks = [...s.blocks.slice(0, idx), merged, ...s.blocks.slice(idx + 2)];
      return {
        ...pushHistory(s),
        blocks: newBlocks,
        subtitleTracks: syncBlocksToTrack(s.subtitleTracks, s.activeTrackId, newBlocks),
      };
    }),

  deleteBlock: (id) =>
    set((s) => {
      const newBlocks = s.blocks.filter((b) => b.id !== id);
      return {
        ...pushHistory(s),
        blocks: newBlocks,
        subtitleTracks: syncBlocksToTrack(s.subtitleTracks, s.activeTrackId, newBlocks),
        selectedBlockId: s.selectedBlockId === id ? null : s.selectedBlockId,
      };
    }),

  selectBlock: (id) => set({ selectedBlockId: id }),

  setStyle: (patch) =>
    set((s) => ({ ...pushHistory(s), style: { ...s.style, ...patch } })),

  applyStylePreset: (style) => set((s) => ({ ...pushHistory(s), style })),

  addCustomFont: (font) =>
    set((s) => ({ customFonts: [...s.customFonts, font] })),

  addOverlay: (overlay) => {
    const id = Math.random().toString(36).slice(2, 10);
    const s = get();
    // Default a fresh image overlay to spanning the whole video. The user
    // can trim it on the timeline. Falls back to a 5-second window starting
    // at the playhead if there's no duration yet (rare — covers the case
    // where the metadata hasn't loaded).
    const dur = s.videoDuration || 0;
    const fallbackEnd = (s.currentTime || 0) + 5;
    const fresh: ImageOverlay = {
      id,
      ...overlay,
      start: overlay.start ?? 0,
      end: overlay.end ?? (dur > 0 ? dur : fallbackEnd),
    };
    set((st) => ({
      ...pushHistory(st),
      overlays: [...st.overlays, fresh],
      selectedOverlayId: id,
    }));
    return id;
  },

  removeOverlay: (id) =>
    set((s) => ({
      ...pushHistory(s),
      overlays: s.overlays.filter((o) => o.id !== id),
      selectedOverlayId:
        s.selectedOverlayId === id ? null : s.selectedOverlayId,
    })),

  updateOverlay: (id, patch) =>
    set((s) => ({
      ...pushHistory(s),
      overlays: s.overlays.map((o) => (o.id === id ? { ...o, ...patch } : o)),
    })),

  selectOverlay: (id) => set({ selectedOverlayId: id }),

  addTextOverlay: (overlay) => {
    const id = Math.random().toString(36).slice(2, 10);
    const s = get();
    // Default a fresh text overlay to "centered, ~3 seconds, around the
    // current playhead". This is the most common starting point — users
    // can drag/edit from there.
    const t = Math.max(0, s.currentTime || 0);
    const fresh: TextOverlay = {
      id,
      text: overlay?.text ?? 'New text',
      start: overlay?.start ?? t,
      end: overlay?.end ?? Math.min(s.videoDuration || t + 3, t + 3),
      positionX: overlay?.positionX ?? 0.5,
      positionY: overlay?.positionY ?? 0.2,
      fontFamily: overlay?.fontFamily ?? s.style.fontFamily,
      fontSize: overlay?.fontSize ?? Math.round(s.style.fontSize * 1.1),
      fontWeight: overlay?.fontWeight ?? 800,
      italic: overlay?.italic ?? false,
      textColor: overlay?.textColor ?? '#ffffff',
      textOutlineColor: overlay?.textOutlineColor ?? '#000000',
      textOutlineWidth: overlay?.textOutlineWidth ?? 3,
      backgroundColor: overlay?.backgroundColor ?? '#000000',
      backgroundOpacity: overlay?.backgroundOpacity ?? 0,
      backgroundPaddingX: overlay?.backgroundPaddingX ?? 16,
      backgroundPaddingY: overlay?.backgroundPaddingY ?? 8,
      backgroundRadius: overlay?.backgroundRadius ?? 8,
      textAlign: overlay?.textAlign ?? 'center',
      maxWidth: overlay?.maxWidth ?? 0.85,
    };
    set((st) => ({
      ...pushHistory(st),
      textOverlays: [...st.textOverlays, fresh],
      selectedTextOverlayId: id,
    }));
    return id;
  },

  removeTextOverlay: (id) =>
    set((s) => ({
      ...pushHistory(s),
      textOverlays: s.textOverlays.filter((t) => t.id !== id),
      selectedTextOverlayId:
        s.selectedTextOverlayId === id ? null : s.selectedTextOverlayId,
    })),

  updateTextOverlay: (id, patch) =>
    set((s) => ({
      ...pushHistory(s),
      textOverlays: s.textOverlays.map((t) =>
        t.id === id ? { ...t, ...patch } : t,
      ),
    })),

  selectTextOverlay: (id) => set({ selectedTextOverlayId: id }),

  setSafeZonePreset: (preset) =>
    set((s) => ({ ...pushHistory(s), safeZone: SAFE_ZONE_PRESETS[preset] })),

  // --- Subtitle tracks ---

  addSubtitleTrack: (label, blocks) => {
    const id = Math.random().toString(36).slice(2, 10);
    set((s) => ({
      ...pushHistory(s),
      subtitleTracks: [
        ...s.subtitleTracks,
        { id, label, visible: true, blocks },
      ],
    }));
    return id;
  },

  removeSubtitleTrack: (id) =>
    set((s) => {
      // Can't remove the last track.
      if (s.subtitleTracks.length <= 1) return s;
      const next = s.subtitleTracks.filter((t) => t.id !== id);
      const wasActive = s.activeTrackId === id;
      const newActive = wasActive ? next[0].id : s.activeTrackId;
      const newBlocks = wasActive ? next[0].blocks : s.blocks;
      return {
        ...pushHistory(s),
        subtitleTracks: next,
        activeTrackId: newActive,
        blocks: newBlocks,
      };
    }),

  setActiveTrack: (id) =>
    set((s) => {
      const track = s.subtitleTracks.find((t) => t.id === id);
      if (!track) return s;
      // Sync current blocks into the old active track, then switch.
      const synced = syncBlocksToTrack(s.subtitleTracks, s.activeTrackId, s.blocks);
      return {
        subtitleTracks: synced,
        activeTrackId: id,
        blocks: track.blocks,
        selectedBlockId: null,
      };
    }),

  toggleTrackVisibility: (id) =>
    set((s) => ({
      subtitleTracks: s.subtitleTracks.map((t) =>
        t.id === id ? { ...t, visible: !t.visible } : t,
      ),
    })),

  toggleTextOverlaysVisible: () =>
    set((s) => ({ textOverlaysVisible: !s.textOverlaysVisible })),
  toggleImageOverlaysVisible: () =>
    set((s) => ({ imageOverlaysVisible: !s.imageOverlaysVisible })),
  toggleCutsVisible: () =>
    set((s) => ({ cutsVisible: !s.cutsVisible })),

  // --- Split at playhead ---

  splitSelectedAtPlayhead: () =>
    set((s) => {
      // Try subtitle block first
      if (s.selectedBlockId) {
        const idx = s.blocks.findIndex((b) => b.id === s.selectedBlockId);
        if (idx < 0) return s;
        const b = s.blocks[idx];
        // If playhead is outside the block, split at midpoint instead of no-op.
        const t =
          s.currentTime > b.start && s.currentTime < b.end
            ? s.currentTime
            : (b.start + b.end) / 2;
        // Find character index closest to time t for text splitting
        const ratio = (t - b.start) / (b.end - b.start);
        const charIdx = Math.round(ratio * b.text.length);
        const left = b.text.slice(0, charIdx).replace(/\s+$/, '') || b.text;
        const right = b.text.slice(charIdx).replace(/^\s+/, '') || b.text;
        let leftWords: Word[] | undefined;
        let rightWords: Word[] | undefined;
        if (b.words && b.words.length > 0) {
          const splitWordIdx = b.words.findIndex((w) => w.start >= t);
          if (splitWordIdx > 0) {
            leftWords = b.words.slice(0, splitWordIdx);
            rightWords = b.words.slice(splitWordIdx);
          }
        }
        const a: SubtitleBlock = {
          id: Math.random().toString(36).slice(2, 10),
          start: b.start,
          end: t,
          text: left,
          words: leftWords,
        };
        const c: SubtitleBlock = {
          id: Math.random().toString(36).slice(2, 10),
          start: t,
          end: b.end,
          text: right,
          words: rightWords,
        };
        const newBlocks = [...s.blocks.slice(0, idx), a, c, ...s.blocks.slice(idx + 1)];
        return {
          ...pushHistory(s),
          blocks: newBlocks,
          subtitleTracks: syncBlocksToTrack(s.subtitleTracks, s.activeTrackId, newBlocks),
          selectedBlockId: a.id,
        };
      }
      // Try text overlay
      if (s.selectedTextOverlayId) {
        const idx = s.textOverlays.findIndex(
          (o) => o.id === s.selectedTextOverlayId,
        );
        if (idx < 0) return s;
        const o = s.textOverlays[idx];
        const t2 =
          s.currentTime > o.start && s.currentTime < o.end
            ? s.currentTime
            : (o.start + o.end) / 2;
        const a: TextOverlay = { ...o, end: t2 };
        const b: TextOverlay = {
          ...o,
          id: Math.random().toString(36).slice(2, 10),
          start: t2,
        };
        return {
          ...pushHistory(s),
          textOverlays: [...s.textOverlays.slice(0, idx), a, b, ...s.textOverlays.slice(idx + 1)],
          selectedTextOverlayId: a.id,
        };
      }
      // Try image overlay
      if (s.selectedOverlayId) {
        const idx = s.overlays.findIndex(
          (o) => o.id === s.selectedOverlayId,
        );
        if (idx < 0) return s;
        const o = s.overlays[idx];
        const t3 =
          s.currentTime > o.start && s.currentTime < o.end
            ? s.currentTime
            : (o.start + o.end) / 2;
        const a: ImageOverlay = { ...o, end: t3 };
        const b: ImageOverlay = {
          ...o,
          id: Math.random().toString(36).slice(2, 10),
          start: t3,
        };
        return {
          ...pushHistory(s),
          overlays: [...s.overlays.slice(0, idx), a, b, ...s.overlays.slice(idx + 1)],
          selectedOverlayId: a.id,
        };
      }
      return s;
    }),

  visibleBlocks: () => {
    const s = get();
    return s.subtitleTracks
      .filter((t) => t.visible)
      .flatMap((t) => t.blocks);
  },

  addCut: (cut) => {
    const id = Math.random().toString(36).slice(2, 10);
    const s = get();
    // Default cut: 1 second wide centred on the playhead, clamped to the
    // video. Falls back to [0, min(1, duration)] if there's no playhead /
    // duration yet (happens before the video metadata is loaded).
    const dur = s.videoDuration || 0;
    const t = Math.max(0, Math.min(dur, s.currentTime || 0));
    const halfWidth = 0.5;
    const fresh: Cut = {
      id,
      start: cut?.start ?? Math.max(0, t - halfWidth),
      end: cut?.end ?? Math.min(dur || t + 1, t + halfWidth),
    };
    set((st) => ({
      ...pushHistory(st),
      cuts: [...st.cuts, fresh],
    }));
    return id;
  },

  updateCut: (id, patch) =>
    set((s) => ({
      ...pushHistory(s),
      cuts: s.cuts.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    })),

  removeCut: (id) =>
    set((s) => ({
      ...pushHistory(s),
      cuts: s.cuts.filter((c) => c.id !== id),
    })),

  clearCuts: () =>
    set((s) => (s.cuts.length === 0 ? s : { ...pushHistory(s), cuts: [] })),

  setStatus: (status, error = null) => set({ status, error }),
  setProgress: (progress) => set({ progress }),
  setCurrentTime: (t) => set({ currentTime: t }),

  undo: () => {
    const s = get();
    if (s.past.length === 0) return;
    const prev = s.past[s.past.length - 1];
    const current = snap(s);
    const label = `Undo: ${describeChange(prev, current)}`;
    set({
      past: s.past.slice(0, -1),
      future: [current, ...s.future].slice(0, HISTORY_LIMIT),
      lastHistoryAt: 0,
      undoRedoLabel: label,
      blocks: prev.blocks,
      subtitleTracks: prev.subtitleTracks,
      activeTrackId: prev.activeTrackId,
      textOverlays: prev.textOverlays,
      overlays: prev.overlays,
      style: prev.style,
      segmentation: prev.segmentation,
      safeZone: prev.safeZone,
      cuts: prev.cuts,
    });
    setTimeout(() => set({ undoRedoLabel: null }), 2000);
  },

  redo: () => {
    const s = get();
    if (s.future.length === 0) return;
    const next = s.future[0];
    const current = snap(s);
    const label = `Redo: ${describeChange(current, next)}`;
    set({
      past: [...s.past, current].slice(-HISTORY_LIMIT),
      future: s.future.slice(1),
      lastHistoryAt: 0,
      undoRedoLabel: label,
      blocks: next.blocks,
      subtitleTracks: next.subtitleTracks,
      activeTrackId: next.activeTrackId,
      textOverlays: next.textOverlays,
      overlays: next.overlays,
      style: next.style,
      segmentation: next.segmentation,
      safeZone: next.safeZone,
      cuts: next.cuts,
    });
    setTimeout(() => set({ undoRedoLabel: null }), 2000);
  },

  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,

  hydrate: (snapshot) =>
    set((s) => {
      // Revoke the previous blob URL (if any) before minting a fresh one
      // from the persisted File. Without this we'd leak a blob URL every
      // time the user loads a new session in the same tab session.
      if (s.videoUrl) URL.revokeObjectURL(s.videoUrl);
      const nextUrl = snapshot.videoFile
        ? URL.createObjectURL(snapshot.videoFile)
        : null;

      // Pick a starting Status that matches what was saved. We don't
      // persist `status` directly because most of its values ('extracting',
      // 'transcribing', 'burning', 'error') are runtime-only — resurrecting
      // them would lie about an operation that isn't actually running.
      let nextStatus: Status = 'idle';
      if (snapshot.blocks.length > 0) nextStatus = 'ready';
      else if (snapshot.extractedAudio) nextStatus = 'audio-ready';

      return {
        videoFile: snapshot.videoFile,
        videoUrl: nextUrl,
        videoDuration: snapshot.videoDuration,
        videoWidth: snapshot.videoWidth,
        videoHeight: snapshot.videoHeight,
        extractedAudio: snapshot.extractedAudio,
        words: snapshot.words,
        blocks: snapshot.blocks,
        // Forward compat: snapshots saved before multi-track existed have no
        // subtitleTracks field — fall back to a single "Original" track with
        // the blocks from the snapshot.
        subtitleTracks: (snapshot as Record<string, unknown>).subtitleTracks
          ? ((snapshot as Record<string, unknown>).subtitleTracks as SubtitleTrack[])
          : [{ id: DEFAULT_TRACK_ID, label: 'Original', visible: true, blocks: snapshot.blocks }],
        activeTrackId:
          ((snapshot as Record<string, unknown>).activeTrackId as string) || DEFAULT_TRACK_ID,
        selectedBlockId: null,
        // Merge over DEFAULT_STYLE so older snapshots saved before we
        // added new Style fields (e.g. karaoke) hydrate with the default
        // for those fields instead of `undefined`.
        style: { ...DEFAULT_STYLE, ...snapshot.style },
        segmentation: snapshot.segmentation,
        customFonts: snapshot.customFonts,
        // Forward compat: image overlays gained start/end. Snapshots saved
        // before that change have undefined for both, so default to "visible
        // for the entire video" — which is what they were before time gating
        // existed.
        overlays: snapshot.overlays.map((o) => ({
          ...o,
          start: o.start ?? 0,
          end: o.end ?? (snapshot.videoDuration || 0),
        })),
        selectedOverlayId: snapshot.selectedOverlayId,
        textOverlays: snapshot.textOverlays ?? [],
        selectedTextOverlayId: snapshot.selectedTextOverlayId ?? null,
        safeZone: snapshot.safeZone,
        // Forward compat: a snapshot saved before cuts existed has no
        // `cuts` field, so default to an empty array instead of undefined.
        cuts: snapshot.cuts ?? [],
        status: nextStatus,
        error: null,
        progress: 0,
        currentTime: 0,
        // Loading a session is the new "starting point" — discard any
        // history that was sitting in the live store.
        past: [],
        future: [],
        lastHistoryAt: 0,
      };
    }),
}));
