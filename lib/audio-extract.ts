import { fetchFile } from '@ffmpeg/util';
import { getFFmpeg, resetFFmpeg } from './ffmpeg-client';

// Extracts the audio track from a video as Opus mono @ 64 kbps in an .ogg
// container. This keeps payloads well under Groq's 25 MB limit even for
// ~15 min of audio.

export type ExtractProgress = (ratio: number) => void;

async function extractOnce(
  videoFile: File,
  onProgress?: ExtractProgress,
): Promise<Uint8Array> {
  const ff = await getFFmpeg();
  if (onProgress) {
    ff.on('progress', ({ progress }) => onProgress(Math.max(0, Math.min(1, progress))));
  }

  const inputName = 'input';
  const outputName = 'audio.ogg';

  // Pre-clean any leftover files from a previous (possibly failed) run —
  // the wasm FS is shared across operations and writeFile will fail with
  // "FS error" if a stale file exists.
  try { await ff.deleteFile(inputName); } catch { /* ignore */ }
  try { await ff.deleteFile(outputName); } catch { /* ignore */ }

  await ff.writeFile(inputName, await fetchFile(videoFile));

  await ff.exec([
    '-i',
    inputName,
    '-vn', // drop video
    '-ac',
    '1', // mono
    '-ar',
    '16000', // 16 kHz is plenty for speech
    '-c:a',
    'libopus',
    '-b:a',
    '64k',
    outputName,
  ]);

  const data = await ff.readFile(outputName);
  // Cleanup virtual FS entries we no longer need.
  try {
    await ff.deleteFile(inputName);
    await ff.deleteFile(outputName);
  } catch {
    // ignore
  }
  return data as Uint8Array;
}

export async function extractAudio(
  videoFile: File,
  onProgress?: ExtractProgress,
): Promise<Uint8Array> {
  try {
    return await extractOnce(videoFile, onProgress);
  } catch (e) {
    // Common case: a previous burn (especially MT-core crashes) left the
    // wasm filesystem in a bad state. Reset and retry once with a fresh
    // ffmpeg instance.
    const msg = e instanceof Error ? e.message : String(e);
    if (/FS error|ErrnoError/i.test(msg)) {
      console.warn('[audio-extract] FS error — resetting ffmpeg and retrying', e);
      resetFFmpeg();
      return await extractOnce(videoFile, onProgress);
    }
    throw e;
  }
}
