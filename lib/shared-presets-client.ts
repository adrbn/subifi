// Thin client for the /api/presets endpoint. All functions return graceful
// defaults on failure so the PresetsBar keeps working offline / mid-outage.

import type { Style } from './types';
import type { SharedPreset } from './shared-presets-store';

export type { SharedPreset };

export async function listSharedPresets(): Promise<SharedPreset[]> {
  try {
    const res = await fetch('/api/presets', { cache: 'no-store' });
    if (!res.ok) return [];
    const data = (await res.json()) as { presets?: SharedPreset[] };
    return data.presets ?? [];
  } catch {
    return [];
  }
}

export async function publishSharedPreset(
  label: string,
  style: Style,
): Promise<SharedPreset | null> {
  try {
    const res = await fetch('/api/presets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label, style }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { preset?: SharedPreset };
    return data.preset ?? null;
  } catch {
    return null;
  }
}

export async function deleteSharedPreset(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/presets?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    return res.ok;
  } catch {
    return false;
  }
}
