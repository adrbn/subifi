// User-saved style presets persisted in localStorage. The built-in presets
// (Cinéma / TikTok / Minimal / News) live in lib/presets.ts and ship with
// the app; this module is for the styles the user has tweaked and wants to
// reuse on future projects.

import type { Style } from './types';

const STORAGE_KEY = 'subifi:user-style-presets:v1';

export type UserStylePreset = {
  id: string;
  label: string;
  style: Style;
  // Wall-clock when the preset was created — purely for sorting newest
  // first in the picker. Not load-bearing.
  createdAt: number;
};

// Read all saved presets. Returns an empty array on parse failure or
// SSR/blocked-storage environments — never throws.
export function loadUserPresets(): UserStylePreset[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // Light shape check — we trust the contents we wrote ourselves but
    // dropping malformed entries means a corrupted slot doesn't kill the
    // whole list.
    return parsed.filter(
      (p): p is UserStylePreset =>
        typeof p === 'object' &&
        p !== null &&
        typeof (p as UserStylePreset).id === 'string' &&
        typeof (p as UserStylePreset).label === 'string' &&
        typeof (p as UserStylePreset).style === 'object',
    );
  } catch {
    return [];
  }
}

function saveUserPresets(presets: UserStylePreset[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  } catch {
    // ignore — quota exceeded or disabled
  }
}

export function addUserPreset(label: string, style: Style): UserStylePreset {
  const preset: UserStylePreset = {
    id: `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    label,
    style,
    createdAt: Date.now(),
  };
  const all = loadUserPresets();
  saveUserPresets([preset, ...all]);
  return preset;
}

export function removeUserPreset(id: string): void {
  const all = loadUserPresets().filter((p) => p.id !== id);
  saveUserPresets(all);
}
