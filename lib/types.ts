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
  // Per-block style overrides — only the fields the user actually changed
  // are stored. The renderer (preview + ASS generator) merges these on top
  // of the global Style. Empty / undefined means "use the global style".
  styleOverride?: Partial<Style>;
};

// A SubtitleTrack groups together one logical "subtitle layer" — the
// original transcription, a translation, an alt-language version, etc.
// Tracks coexist: the user can toggle each one's visibility independently
// via the eye button on the timeline lane. Visible tracks are concatenated
// into the burn output (and the preview), so multiple languages can be
// burned simultaneously if the user positions them carefully.
//
// The `blocks` array on a track is the same shape as the legacy top-level
// `blocks` array — every per-block helper (segmentation, splitting, merge)
// works on it unchanged.
export type SubtitleTrack = {
  id: string;
  label: string; // e.g. "Original", "Français", "한국어"
  visible: boolean;
  blocks: SubtitleBlock[];
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
  // Multiplier applied to the font's natural line height. 1.0 = tight,
  // 1.2 ≈ default reading rhythm, 1.6 ≈ loose. Preview-only — libass uses
  // the font's intrinsic line height in burned output.
  lineHeight: number;
  // Extra space between letters, in pixels (positive or negative). Maps
  // 1:1 to ASS `Spacing` / inline `\fsp` so the burn matches the preview.
  letterSpacing: number;
  // Extra space between words, in pixels. CSS `word-spacing` in preview;
  // emulated via `\fsp` reset trick or space-padding in ASS burn.
  wordSpacing: number;
  // Karaoke / word-pop: highlight the currently-spoken word in real time.
  // Requires word-level timings (block.words). When off, the block renders
  // as a single styled string and karaokeBaseColor is ignored.
  karaoke: boolean;
  // Color used for words that have NOT yet been spoken (the "dim" color).
  // The active and already-spoken words use textColor.
  karaokeBaseColor: string;
  // Wiggle effect: each character gets a small per-glyph offset so the text
  // looks alive. Preview renders an animated staggered CSS transform; the
  // ASS burn emits a static per-character \frz rotation (same amplitude)
  // because libass can't cheaply animate a continuous wiggle.
  wiggle: boolean;
  wiggleAmplitude: number; // degrees (and rough px offset in preview)
  wiggleSpeed: number; // Hz — preview only
  // Entrance animation applied at block start. 'fade' also fades out at the
  // end (symmetric). 'pop' scales from 0 → 115% → 100%. 'typewriter' reveals
  // one character at a time. entranceDuration is in seconds.
  entrance: 'none' | 'typewriter' | 'pop' | 'fade';
  entranceDuration: number;
  // Exit animation applied at block end. Currently only 'fade' (fade-out).
  // Kept independent from `entrance` so the user can mix any entrance with
  // any exit (e.g. typewriter-in + fade-out).
  exit: 'none' | 'fade';
  exitDuration: number;
};

export type SegmentationMode = 'cinema' | 'tiktok' | 'word' | 'custom';

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
  // Time range during which the overlay is visible. Image overlays default
  // to spanning the whole video but can be trimmed on the timeline. Burn-in
  // wraps the overlay filter in `enable='between(t,start,end)'` and the DOM
  // preview hides the <img> outside this range.
  start: number; // seconds
  end: number; // seconds
};

// Free-form text overlays — independent of the auto-generated subtitle
// blocks. They have their own time range, position, and look. Used for
// titles, callouts, captions, etc. They burn into the same ASS file the
// regular subtitles use, but each overlay defines its own ASS Style.
export type TextOverlay = {
  id: string;
  text: string; // may contain \n
  start: number; // seconds
  end: number; // seconds
  positionX: number; // 0..1 center-anchored
  positionY: number; // 0..1 center-anchored
  fontFamily: string;
  fontSize: number; // px relative to video pixel height
  fontWeight: number;
  italic: boolean;
  textColor: string;
  textOutlineColor: string;
  textOutlineWidth: number;
  backgroundColor: string;
  backgroundOpacity: number; // 0..1
  backgroundPaddingX: number;
  backgroundPaddingY: number;
  backgroundRadius: number;
  textAlign: 'left' | 'center' | 'right';
  maxWidth: number; // 0..1
  wiggle?: boolean;
  wiggleAmplitude?: number;
  wiggleSpeed?: number;
  entrance?: 'none' | 'typewriter' | 'pop' | 'fade';
  entranceDuration?: number;
  exit?: 'none' | 'fade';
  exitDuration?: number;
};

// A cut is a time range that is REMOVED from the source video at burn time.
// Cuts are stored in original-video time. The burn pipeline turns them into
// the inverse "keep ranges" via lib/cuts.ts and uses ffmpeg trim+concat to
// stitch the kept segments together. Subtitle and text overlay timings are
// remapped onto the post-cut timeline so they line up with the trimmed
// video. Cuts are preview-aware (the timeline shows them in red) but the
// preview itself does NOT skip them — they only affect the exported MP4.
export type Cut = {
  id: string;
  start: number; // seconds, original video time
  end: number; // seconds, original video time
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
