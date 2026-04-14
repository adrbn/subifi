import { getFFmpeg } from './ffmpeg-client';

// Splits an extracted Opus/Ogg audio track into ~20-minute chunks so each
// upload stays well under Groq's 25 MB limit. At 64 kbps mono a 20-minute
// chunk is ~9.6 MB. We stream-copy (`-c copy`) so there's no re-encode cost.

const INPUT_NAME = 'chunk_input.ogg';
const CHUNK_SECONDS = 1200;

export type AudioChunk = { bytes: Uint8Array; startSec: number };

export async function splitAudioBytes(
  bytes: Uint8Array,
  totalDurationSec: number,
): Promise<AudioChunk[]> {
  const ff = await getFFmpeg();

  try { await ff.deleteFile(INPUT_NAME); } catch { /* ignore */ }
  await ff.writeFile(INPUT_NAME, bytes);

  const chunks: AudioChunk[] = [];
  try {
    for (let start = 0; start < totalDurationSec; start += CHUNK_SECONDS) {
      const len = Math.min(CHUNK_SECONDS, totalDurationSec - start);
      const outName = `chunk_${start}.ogg`;
      try { await ff.deleteFile(outName); } catch { /* ignore */ }

      // Fast seek (`-ss` before `-i`) is keyframe-aligned, which is fine
      // for opus because frame boundaries are ~20 ms apart.
      await ff.exec([
        '-ss', String(start),
        '-i', INPUT_NAME,
        '-t', String(len),
        '-c', 'copy',
        outName,
      ]);
      const data = await ff.readFile(outName);
      const arr =
        data instanceof Uint8Array
          ? data
          : typeof data === 'string'
            ? new TextEncoder().encode(data)
            : new Uint8Array();
      chunks.push({ bytes: arr, startSec: start });
      try { await ff.deleteFile(outName); } catch { /* ignore */ }
    }
  } finally {
    try { await ff.deleteFile(INPUT_NAME); } catch { /* ignore */ }
  }
  return chunks;
}
