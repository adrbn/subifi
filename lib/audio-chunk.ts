import { getFFmpeg } from './ffmpeg-client';

// Splits an extracted Opus/Ogg audio track into ~8-minute chunks so each
// upload stays under the tightest body-size cap in the pipeline. Groq
// accepts up to 25 MB, but Vercel Serverless Functions cap the request
// body at 4.5 MB on Hobby/Pro (default), so that's the real constraint
// once deployed. At 64 kbps mono an 8-minute chunk is ~3.8 MB — well
// under 4.5 with headroom for container overhead. We stream-copy
// (`-c copy`) so there's no re-encode cost.

const INPUT_NAME = 'chunk_input.ogg';
const CHUNK_SECONDS = 480;

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
