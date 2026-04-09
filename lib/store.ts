import { create } from 'zustand';
import type {
  CustomFont,
  ImageOverlay,
  SafeZone,
  SafeZonePreset,
  SegmentationConfig,
  Status,
  Style,
  SubtitleBlock,
  Word,
} from './types';
import {
  DEFAULT_OVERLAYS,
  DEFAULT_SAFE_ZONE,
  DEFAULT_SEGMENTATION,
  DEFAULT_STYLE,
  SAFE_ZONE_PRESETS,
} from './presets';
import { segmentWords } from './segmenter';
import type { SessionSnapshot } from './persist';

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
  blocks: SubtitleBlock[];

  // Styling
  style: Style;
  segmentation: SegmentationConfig;
  customFonts: CustomFont[];
  overlays: ImageOverlay[];
  selectedOverlayId: string | null;
  safeZone: SafeZone;

  // Runtime
  status: Status;
  error: string | null;
  progress: number; // 0..1, used for extraction / burning
  currentTime: number; // playback position in seconds
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
  setStyle: (patch: Partial<Style>) => void;
  applyStylePreset: (style: Style) => void;
  addCustomFont: (font: CustomFont) => void;
  addOverlay: (overlay: Omit<ImageOverlay, 'id'>) => string;
  removeOverlay: (id: string) => void;
  updateOverlay: (id: string, patch: Partial<ImageOverlay>) => void;
  selectOverlay: (id: string | null) => void;
  setSafeZonePreset: (preset: SafeZonePreset) => void;
  setStatus: (status: Status, error?: string | null) => void;
  setProgress: (progress: number) => void;
  setCurrentTime: (t: number) => void;
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

  style: DEFAULT_STYLE,
  segmentation: DEFAULT_SEGMENTATION,
  customFonts: [],
  overlays: DEFAULT_OVERLAYS,
  selectedOverlayId: null,
  safeZone: DEFAULT_SAFE_ZONE,

  status: 'idle',
  error: null,
  progress: 0,
  currentTime: 0,

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
      status: 'idle',
      error: null,
      progress: 0,
      currentTime: 0,
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
      status: 'idle',
      error: null,
      progress: 0,
      currentTime: 0,
    });
  },

  setExtractedAudio: (audio) => set({ extractedAudio: audio }),

  setBlocks: (blocks) => set({ blocks, status: 'ready' }),

  setWords: (words) => {
    const { segmentation } = get();
    const blocks = segmentWords(words, segmentation);
    set({ words, blocks, status: 'ready' });
  },

  resegment: (cfg) => {
    const { words, segmentation } = get();
    const next = { ...segmentation, ...(cfg ?? {}) };
    set({ segmentation: next, blocks: segmentWords(words, next) });
  },

  updateBlock: (id, patch) =>
    set((s) => ({
      blocks: s.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)),
    })),

  splitBlockAt: (id, charIndex) =>
    set((s) => {
      const idx = s.blocks.findIndex((b) => b.id === id);
      if (idx < 0) return s;
      const b = s.blocks[idx];
      const left = b.text.slice(0, charIndex).replace(/\s+$/, '');
      const right = b.text.slice(charIndex).replace(/^\s+/, '');
      if (!left || !right) return s;

      // If we have word-level timings, find the word boundary closest to
      // the character index and use its real start time. Otherwise fall
      // back to linear interpolation.
      let mid = b.start + (b.end - b.start) * (charIndex / b.text.length);
      let leftWords: Word[] | undefined;
      let rightWords: Word[] | undefined;
      if (b.words && b.words.length > 0) {
        // Walk the plain word tokens and find which one contains charIndex.
        // We use the raw text join to match the editable text closely.
        let running = 0;
        let splitWordIdx = 0;
        for (let i = 0; i < b.words.length; i++) {
          const wLen = b.words[i].text.length + (i > 0 ? 1 : 0); // +1 for space
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
      return {
        blocks: [...s.blocks.slice(0, idx), a, c, ...s.blocks.slice(idx + 1)],
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
      return {
        blocks: [...s.blocks.slice(0, idx), merged, ...s.blocks.slice(idx + 2)],
      };
    }),

  deleteBlock: (id) =>
    set((s) => ({ blocks: s.blocks.filter((b) => b.id !== id) })),

  setStyle: (patch) => set((s) => ({ style: { ...s.style, ...patch } })),

  applyStylePreset: (style) => set({ style }),

  addCustomFont: (font) =>
    set((s) => ({ customFonts: [...s.customFonts, font] })),

  addOverlay: (overlay) => {
    const id = Math.random().toString(36).slice(2, 10);
    set((s) => ({
      overlays: [...s.overlays, { id, ...overlay }],
      selectedOverlayId: id,
    }));
    return id;
  },

  removeOverlay: (id) =>
    set((s) => ({
      overlays: s.overlays.filter((o) => o.id !== id),
      selectedOverlayId:
        s.selectedOverlayId === id ? null : s.selectedOverlayId,
    })),

  updateOverlay: (id, patch) =>
    set((s) => ({
      overlays: s.overlays.map((o) => (o.id === id ? { ...o, ...patch } : o)),
    })),

  selectOverlay: (id) => set({ selectedOverlayId: id }),

  setSafeZonePreset: (preset) => set({ safeZone: SAFE_ZONE_PRESETS[preset] }),

  setStatus: (status, error = null) => set({ status, error }),
  setProgress: (progress) => set({ progress }),
  setCurrentTime: (t) => set({ currentTime: t }),

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
        style: snapshot.style,
        segmentation: snapshot.segmentation,
        customFonts: snapshot.customFonts,
        overlays: snapshot.overlays,
        selectedOverlayId: snapshot.selectedOverlayId,
        safeZone: snapshot.safeZone,
        status: nextStatus,
        error: null,
        progress: 0,
        currentTime: 0,
      };
    }),
}));
