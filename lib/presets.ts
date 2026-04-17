import type {
  ImageOverlay,
  SafeZone,
  SafeZonePreset,
  SegmentationConfig,
  Style,
  StylePreset,
} from './types';

// Style presets applied with a single click. Each preset is a full Style
// object; the editor swaps the entire style atomically so the user can still
// tune afterwards without losing their tuning (it becomes the new baseline).

const baseStyle: Style = {
  fontFamily: 'Inter',
  fontSize: 42,
  fontWeight: 700,
  italic: false,
  textColor: '#ffffff',
  textOutlineColor: '#000000',
  textOutlineWidth: 2,
  backgroundColor: '#000000',
  backgroundOpacity: 0.75,
  backgroundPaddingX: 18,
  backgroundPaddingY: 10,
  backgroundRadius: 10,
  positionX: 0.5,
  positionY: 0.88,
  maxWidth: 1,
  textAlign: 'center',
  lineHeight: 1.2,
  letterSpacing: 0,
  wordSpacing: 0,
  karaoke: false,
  karaokeBaseColor: '#94a3b8', // slate-400 — neutral dim
  wiggle: false,
  wiggleAmplitude: 6,
  wiggleSpeed: 2,
};

export const STYLE_PRESETS: StylePreset[] = [
  {
    id: 'cinema',
    label: 'Cinéma',
    style: { ...baseStyle },
  },
  {
    id: 'tiktok',
    label: 'TikTok',
    style: {
      ...baseStyle,
      fontFamily: 'Inter',
      fontSize: 56,
      fontWeight: 900,
      textColor: '#fde047', // yellow-300
      textOutlineColor: '#000000',
      textOutlineWidth: 4,
      backgroundColor: '#000000',
      backgroundOpacity: 0,
      backgroundPaddingX: 0,
      backgroundPaddingY: 0,
      backgroundRadius: 0,
      positionY: 0.78,
      maxWidth: 1,
    },
  },
  {
    // Karaoke / word-pop preset — words start dim, light up as the audio
    // hits them. Requires the transcription to have word-level timings,
    // which Groq Whisper provides by default.
    id: 'karaoke',
    label: 'Karaoke',
    style: {
      ...baseStyle,
      fontSize: 60,
      fontWeight: 900,
      textColor: '#fde047', // bright yellow for the spoken word
      textOutlineColor: '#000000',
      textOutlineWidth: 5,
      backgroundOpacity: 0,
      positionY: 0.8,
      maxWidth: 1,
      karaoke: true,
      karaokeBaseColor: '#ffffff',
    },
  },
  {
    id: 'minimal',
    label: 'Minimal',
    style: {
      ...baseStyle,
      fontSize: 40,
      fontWeight: 500,
      textColor: '#ffffff',
      textOutlineColor: '#000000',
      textOutlineWidth: 3,
      backgroundColor: '#000000',
      backgroundOpacity: 0,
      backgroundPaddingX: 0,
      backgroundPaddingY: 0,
      backgroundRadius: 0,
    },
  },
  {
    id: 'news',
    label: 'News',
    style: {
      ...baseStyle,
      fontFamily: 'Inter',
      fontSize: 40,
      fontWeight: 700,
      textColor: '#ffffff',
      textOutlineColor: '#000000',
      textOutlineWidth: 0,
      backgroundColor: '#dc2626', // red-600
      backgroundOpacity: 0.92,
      backgroundPaddingX: 22,
      backgroundPaddingY: 12,
      backgroundRadius: 4,
      positionY: 0.9,
      maxWidth: 1,
    },
  },
];

export const DEFAULT_STYLE: Style = STYLE_PRESETS[0].style;

export const SEGMENTATION_PRESETS: Record<
  'cinema' | 'tiktok' | 'word',
  SegmentationConfig
> = {
  cinema: {
    mode: 'cinema',
    maxCharsPerLine: 42,
    maxLines: 2,
    maxDurationSec: 6,
    minDurationSec: 1,
    maxWordsPerBlock: 18,
  },
  tiktok: {
    mode: 'tiktok',
    maxCharsPerLine: 22,
    maxLines: 1,
    maxDurationSec: 1.8,
    minDurationSec: 0.4,
    maxWordsPerBlock: 3,
  },
  // Word-by-word: each spoken word becomes its own block. Pairs naturally
  // with the karaoke style preset for ultra-readable single-word reels.
  // We zero minDurationSec so very short words don't fight with the
  // segmenter's hard-boundary logic.
  word: {
    mode: 'word',
    maxCharsPerLine: 40,
    maxLines: 1,
    maxDurationSec: 4,
    minDurationSec: 0,
    maxWordsPerBlock: 1,
  },
};

export const DEFAULT_SEGMENTATION: SegmentationConfig =
  SEGMENTATION_PRESETS.cinema;

export const DEFAULT_OVERLAYS: ImageOverlay[] = [];

// Safe-area presets — fractions of video dimensions considered occluded by
// the target platform's UI chrome. Values are approximate and measured from
// screenshots of the apps' capture UI (circa 2026).
export const SAFE_ZONE_PRESETS: Record<SafeZonePreset, SafeZone> = {
  off: {
    preset: 'off',
    topPct: 0,
    bottomPct: 0,
    leftPct: 0,
    rightPct: 0,
  },
  instagram: {
    // Reels: top ~14% has the "Stories" camera bar; bottom ~18% has likes,
    // caption, username, music. Sides mostly clear.
    preset: 'instagram',
    topPct: 0.14,
    bottomPct: 0.18,
    leftPct: 0.02,
    rightPct: 0.15, // right-side action rail
  },
  tiktok: {
    // TikTok: top ~10% "For You / Following"; bottom ~22% caption + music;
    // right ~15% action rail.
    preset: 'tiktok',
    topPct: 0.1,
    bottomPct: 0.22,
    leftPct: 0.02,
    rightPct: 0.15,
  },
  'youtube-shorts': {
    preset: 'youtube-shorts',
    topPct: 0.08,
    bottomPct: 0.2,
    leftPct: 0.02,
    rightPct: 0.13,
  },
};

export const DEFAULT_SAFE_ZONE: SafeZone = SAFE_ZONE_PRESETS.off;
