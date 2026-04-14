// Server-side storage for the shared-presets library. Pluggable so we
// can swap the in-memory default for Vercel KV / Upstash Redis / Supabase
// without touching the API route or the client.
//
// The default implementation is a module-level Map that survives as long
// as the serverless instance stays warm. On Vercel that means preset
// submissions persist across requests on the same instance but can be
// lost on a cold start / redeploy. That's acceptable for a v1 public
// library — the UX degrades gracefully (the list just looks shorter),
// and replacing this with a real KV store is a one-function swap below.

import type { Style } from './types';

export type SharedPreset = {
  id: string;
  label: string;
  style: Style;
  createdAt: number;
};

export interface SharedPresetStore {
  list(): Promise<SharedPreset[]>;
  add(preset: SharedPreset): Promise<void>;
  remove(id: string): Promise<boolean>;
}

class MemoryStore implements SharedPresetStore {
  private data: SharedPreset[] = [];

  async list(): Promise<SharedPreset[]> {
    // Newest first so fresh contributions show up at the top of the bar.
    return [...this.data].sort((a, b) => b.createdAt - a.createdAt);
  }

  async add(preset: SharedPreset): Promise<void> {
    this.data.push(preset);
  }

  async remove(id: string): Promise<boolean> {
    const before = this.data.length;
    this.data = this.data.filter((p) => p.id !== id);
    return this.data.length < before;
  }
}

// Singleton accessor. Swap the constructor here to switch backends:
//   return new VercelKvStore(process.env.KV_URL!)
//   return new SupabaseStore(supabaseClient)
// etc.
let _store: SharedPresetStore | null = null;
export function getSharedPresetStore(): SharedPresetStore {
  if (!_store) _store = new MemoryStore();
  return _store;
}
