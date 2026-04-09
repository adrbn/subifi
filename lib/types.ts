// Shared type definitions for the editor.

export type Word = {
  text: string;
  start: number; // seconds
  end: number; // seconds
};

export type SubtitleBlock = {
  id: string;
  start: number; // seconds
  end: number; // seconds
  text: string; // may contain \n
  words?: Word[]; // preserved so re-segmentation can rebuild from raw words
};

export type Style = {
  fontFamily: string; // Google Font family name, or uploaded font name
  fontSize: number; // px, relative to video pixel height
  fontWeight: number;
  italic: boolean;
  textColor: string; // hex, e.g. "#ffffff"
  textOutlineColor: string; // hex
  textOutlineWidth: number; // px
  backgroundColor: string; // hex
  backgroundOpacity: number; // 0..1
  backgroundPaddingX: number; // px
  backgroundPaddingY: number; // px
  backgroundRadius: number; // px
  positionX: number; // 0..1 fraction of video width, center of textbox
  positionY: number; // 0..1 fraction of video height, center of textbox
  maxWidth: number; // 0..1 fraction of video width
  textAlign: 'left' | 'center' | 'right';
};

export type SegmentationMode = 'cinema' | 'tiktok' | 'custom';

export type SegmentationConfig = {
  mode: SegmentationMode;
  maxCharsPerLine: number;
  maxLines: number;
  maxDurationSec: number;
  minDurationSec: number;
  maxWordsPerBlock: number; // used mainly for tiktok
};

export type CustomFont = {
  name: string; // family name to use in CSS + ASS
  dataUrl: string; // data:application/font-... for CSS @font-face
  buffer: ArrayBuffer; // raw bytes for ffmpeg FS when burning
  format: 'ttf' | 'otf' | 'woff' | 'woff2';
};

// Freely-positioned image overlays (logos, stickers, watermarks…). The user
// can add as many as they want, drag them on the preview, and wheel-zoom to
// resize. Position is center-anchored as a fraction of the video dimensions
// so it scales cleanly with the export resolution.
export type ImageOverlay = {
  id: string;
  dataUrl: string;
  mime: string;
  positionX: number; // 0..1, center-anchored
  positionY: number; // 0..1, center-anchored
  width: number; // 0..1 fraction of video width
  opacity: number; // 0..1
};

// Safe-area overlays modelled after the UI chrome of vertical social apps.
// Values are fractions of the video height (top/bottom) or width (left/right).
export type SafeZonePreset = 'off' | 'instagram' | 'tiktok' | 'youtube-shorts';

export type SafeZone = {
  preset: SafeZonePreset;
  // Fractions of video dimensions that are considered unsafe (UI chrome).
  topPct: number;
  bottomPct: number;
  leftPct: number;
  rightPct: number;
};

export type Status =
  | 'idle'
  | 'extracting'
  | 'audio-ready' // audio extracted, waiting for user to trigger transcription
  | 'transcribing'
  | 'ready'
  | 'burning'
  | 'error';

export type StylePreset = {
  id: string;
  label: string;
  style: Style;
};
