import { fetchFile } from '@ffmpeg/util';
import { getFFmpeg } from './ffmpeg-client';

// Extracts the audio track from a video as Opus mono @ 64 kbps in an .ogg
// container. This keeps payloads well under Groq's 25 MB limit even for
// ~15 min of audio.

export type ExtractProgress = (ratio: number) => void;

export async function extractAudio(
  videoFile: File,
  onProgress?: ExtractProgress,
): Promise<Uint8Array> {
  const ff = await getFFmpeg();
  if (onProgress) {
    ff.on('progress', ({ progress }) => onProgress(Math.max(0, Math.min(1, progress))));
  }

  const inputName = 'input';
  const outputName = 'audio.ogg';

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
