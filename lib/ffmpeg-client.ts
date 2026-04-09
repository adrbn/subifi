// Singleton loader for ffmpeg.wasm. Keeps a single FFmpeg instance across
// extract+burn operations so we don't re-download the core each time.

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

// Multi-threaded core: ~2-3x faster than the single-threaded core on heavy
// operations like burn-in. Requires SharedArrayBuffer, which in turn requires
// the page to be cross-origin isolated (COOP: same-origin + COEP: require-corp
// — see next.config.ts). Needs an extra workerURL on top of core + wasm.
const CORE_BASE = 'https://unpkg.com/@ffmpeg/core-mt@0.12.10/dist/umd';

let ffmpegInstance: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;

export type FFmpegProgress = {
  progress: number; // 0..1
  time: number; // seconds
};

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
    try {
      const ff = new FFmpeg();
      if (onProgress) ff.on('progress', onProgress);
      ff.on('log', ({ message }) => {
        // Route ffmpeg's own stderr to the browser console so we can see
        // what's happening during extract/burn.
        console.debug('[ffmpeg]', message);
        if (onLog) onLog(message);
      });
      await ff.load({
        coreURL: await toBlobURL(
          `${CORE_BASE}/ffmpeg-core.js`,
          'text/javascript',
        ),
        wasmURL: await toBlobURL(
          `${CORE_BASE}/ffmpeg-core.wasm`,
          'application/wasm',
        ),
        workerURL: await toBlobURL(
          `${CORE_BASE}/ffmpeg-core.worker.js`,
          'text/javascript',
        ),
      });
      ffmpegInstance = ff;
      return ff;
    } catch (err) {
      // Reset so a retry actually retries instead of returning the cached
      // rejected promise.
      loadPromise = null;
      throw err;
    }
  })();

  return loadPromise;
}

export function resetFFmpeg(): void {
  ffmpegInstance = null;
  loadPromise = null;
}
