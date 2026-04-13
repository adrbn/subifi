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
