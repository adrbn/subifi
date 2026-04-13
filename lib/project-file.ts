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
  imageOverlays: Array<ImageOverlay>;
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
    imageOverlays: state.overlays,
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
