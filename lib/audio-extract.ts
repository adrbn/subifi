import { FFFSType } from '@ffmpeg/ffmpeg';
import { getFFmpeg, resetFFmpeg } from './ffmpeg-client';

// Extracts the audio track from a video as Opus mono @ 64 kbps in an .ogg
// container. This keeps payloads well under Groq's 25 MB limit even for
// ~15 min of audio.
//
// Implementation note: we mount the input File via WORKERFS instead of
// reading it into a Uint8Array and writing it into MEMFS. The previous
// fetchFile/writeFile path hit a hard wall at ~2 GB (FileReader's
// ArrayBuffer ceiling — the dreaded "File could not be read! Code=-1"
// users saw on long movies) and doubled peak memory even below that.
// WORKERFS lets ffmpeg stream-read the file by chunks from the browser
// file handle, so a 2-hour feature is fine.

export type ExtractProgress = (ratio: number) => void;

const MOUNT_POINT = '/mnt';

async function extractOnce(
  videoFile: File,
  onProgress?: ExtractProgress,
): Promise<Uint8Array> {
  const ff = await getFFmpeg();
  if (onProgress) {
    ff.on('progress', ({ progress }) => onProgress(Math.max(0, Math.min(1, progress))));
  }

  const outputName = 'audio.ogg';
  const inputPath = `${MOUNT_POINT}/${videoFile.name}`;

  // Make sure the mount point exists and nothing stale is sitting there.
  // Mount/unmount/mkdir each tolerate their "already done / nothing to do"
  // variants so a retry after a failure is safe.
  try { await ff.unmount(MOUNT_POINT); } catch { /* not mounted */ }
  try { await ff.createDir(MOUNT_POINT); } catch { /* already exists */ }
  try { await ff.deleteFile(outputName); } catch { /* ignore */ }

  await ff.mount(FFFSType.WORKERFS, { files: [videoFile] }, MOUNT_POINT);

  try {
    await ff.exec([
      '-i',
      inputPath,
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
    return data as Uint8Array;
  } finally {
    // Always unmount so the next run can remount (and so the browser can
    // release the underlying file handle).
    try { await ff.unmount(MOUNT_POINT); } catch { /* ignore */ }
    try { await ff.deleteFile(outputName); } catch { /* ignore */ }
  }
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
