// Serialize / deserialize full project state to a portable JSON file.
// The video BLOB itself is not embedded — too large — but we now ship a
// manifest section with the metadata needed to identify and optionally
// rehydrate the source video on import:
//
//   - name / size / type / duration: informational, shown in the UI
//   - headHash: content-addressable id (see lib/video-hash.ts). Used to
//     look the video up in the IndexedDB cache on a re-import, and to
//     soft-warn when the user drops a different file than the one the
//     manifest was exported from.
//   - coverDataUrl: a small JPEG thumbnail (t=1s) so the user can visually
//     identify a project in a file browser or a future recents list.
//
// Backwards compatibility: v1 files (no manifest, no customFonts layout
// change) still round-trip — the importer fills manifest with `null`.

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

const FORMAT_VERSION = 2 as const;

export type ProjectManifest = {
  name: string;
  size: number;
  type: string;
  duration: number;
  headHash: string;
  coverDataUrl: string | null;
} | null;

// The portable shape — no File, no Uint8Array, no ArrayBuffer. Custom
// fonts carry their dataUrl (already base64) so they survive JSON.
export type ProjectFile = {
  _format: 'subifi-project';
  _version: 1 | typeof FORMAT_VERSION;
  exportedAt: string; // ISO 8601
  manifest: ProjectManifest;
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

type ExportInput = {
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
  manifest: ProjectManifest;
};

export function exportProject(state: ExportInput): string {
  const file: ProjectFile = {
    _format: 'subifi-project',
    _version: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    manifest: state.manifest,
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
  const rec = parsed as Record<string, unknown>;
  // v1 files had no manifest; synthesize a null one so downstream code
  // can assume the field is present (and branch on null to prompt the
  // user for the source video).
  if (rec.manifest === undefined) {
    rec.manifest = null;
  }
  return rec as unknown as ProjectFile;
}
