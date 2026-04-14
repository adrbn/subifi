// Singleton loader for ffmpeg.wasm. Keeps a single FFmpeg instance across
// extract+burn operations so we don't re-download the core each time.
//
// Supports two modes:
//   - Multi-threaded (core-mt): ~2-3x faster, requires SharedArrayBuffer +
//     cross-origin isolation (COOP/COEP headers). Default on browsers that
//     support it.
//   - Single-threaded (core): slower but universally compatible. Used as
//     automatic fallback when MT core fails to load OR when a previous burn
//     stalled (common on Windows where libass threading deadlocks in WASM).
//
// The choice is persisted in localStorage so a user who hit the deadlock
// doesn't have to wait 30s for stall detection on every subsequent burn.

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

const CORE_MT_BASE = 'https://unpkg.com/@ffmpeg/core-mt@0.12.10/dist/umd';
const CORE_ST_BASE = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd';

const LS_KEY = 'ffmpeg-force-st';

let ffmpegInstance: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;
let currentMode: 'mt' | 'st' | null = null;

export type FFmpegProgress = {
  progress: number; // 0..1
  time: number; // microseconds of encoded output
};

// ---------------------------------------------------------------------------
// Mode helpers
// ---------------------------------------------------------------------------

function canUseMultiThread(): boolean {
  return (
    typeof SharedArrayBuffer !== 'undefined' &&
    typeof crossOriginIsolated !== 'undefined' &&
    crossOriginIsolated
  );
}

function userPrefersSingleThread(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      localStorage.getItem(LS_KEY) === '1'
    );
  } catch {
    return false;
  }
}

/** Force all future loads to use the single-threaded core. */
export function forceSingleThread(): void {
  try {
    if (typeof window !== 'undefined') localStorage.setItem(LS_KEY, '1');
  } catch {
    // localStorage may be unavailable in some contexts
  }
  resetFFmpeg();
}

/** Clear the single-thread preference (e.g. user wants to try MT again). */
export function clearSingleThreadPreference(): void {
  try {
    if (typeof window !== 'undefined') localStorage.removeItem(LS_KEY);
  } catch {
    // ignore
  }
}

/** Whether the currently loaded core is multi-threaded. */
export function isMultiThreaded(): boolean {
  return currentMode === 'mt';
}

// ---------------------------------------------------------------------------
// Core loader
// ---------------------------------------------------------------------------

export async function getFFmpeg(
  onProgress?: (p: FFmpegProgress) => void,
  onLog?: (msg: string) => void,
): Promise<FFmpeg> {
  if (ffmpegInstance && ffmpegInstance.loaded) {
    if (onProgress) ffmpegInstance.on('progress', onProgress);
    if (onLog) ffmpegInstance.on('log', ({ message }) => onLog(message));
    return ffmpegInstance;
  }
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const useMT = canUseMultiThread() && !userPrefersSingleThread();
    const base = useMT ? CORE_MT_BASE : CORE_ST_BASE;

    try {
      const ff = new FFmpeg();
      if (onProgress) ff.on('progress', onProgress);
      ff.on('log', ({ message }) => {
        console.debug('[ffmpeg]', message);
        if (onLog) onLog(message);
      });

      const coreURL = await toBlobURL(
        `${base}/ffmpeg-core.js`,
        'text/javascript',
      );
      const wasmURL = await toBlobURL(
        `${base}/ffmpeg-core.wasm`,
        'application/wasm',
      );

      if (useMT) {
        const workerURL = await toBlobURL(
          `${base}/ffmpeg-core.worker.js`,
          'text/javascript',
        );
        await ff.load({ coreURL, wasmURL, workerURL });
      } else {
        await ff.load({ coreURL, wasmURL });
      }

      ffmpegInstance = ff;
      currentMode = useMT ? 'mt' : 'st';
      console.debug(`[ffmpeg] loaded in ${currentMode} mode`);
      return ff;
    } catch (err) {
      loadPromise = null;
      // If MT failed to load, fall back to ST automatically.
      if (useMT) {
        console.warn(
          '[ffmpeg] multi-threaded core failed to load, falling back to single-threaded',
          err,
        );
        forceSingleThread();
        return getFFmpeg(onProgress, onLog);
      }
      throw err;
    }
  })();

  return loadPromise;
}

export function resetFFmpeg(): void {
  // Terminate the previous instance to free wasm memory + worker — without
  // this, a stale instance keeps its virtual filesystem alive and subsequent
  // operations on a "fresh" instance can still hit FS errors from cross-talk.
  if (ffmpegInstance) {
    try {
      ffmpegInstance.terminate();
    } catch {
      // ignore — instance may already be terminated
    }
  }
  ffmpegInstance = null;
  loadPromise = null;
  currentMode = null;
}
