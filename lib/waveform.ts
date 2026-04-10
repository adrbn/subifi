// Waveform peak extraction for the timeline.
//
// Decodes the extracted audio (Opus/OGG produced by lib/audio-extract.ts)
// into PCM samples via the browser's AudioContext, then downsamples to a
// fixed number of "buckets" — each bucket holds the absolute peak amplitude
// in its slice of the audio. The Timeline component renders one vertical
// bar per bucket, which is the standard waveform look.

// Number of buckets we compute. ~2000 covers most timeline widths comfortably
// — we render at the device resolution and the canvas can resample down with
// nearest-neighbor without visible artifacts.
export const WAVEFORM_BUCKETS = 2000;

// Cached AudioContext — creating one per call leaks contexts and Chrome
// caps the total at ~6 before refusing to make more.
let audioCtx: AudioContext | null = null;
function getAudioContext(): AudioContext {
  if (audioCtx) return audioCtx;
  // Lazy-create so SSR / Node test environments don't crash on import.
  // Safari historically only exposed `webkitAudioContext`; cast through
  // `unknown` to avoid pulling in the WebKit-specific lib types.
  const w = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) throw new Error('Web Audio API not available');
  const created = new Ctor();
  audioCtx = created;
  return created;
}

// Returns a Float32Array of length `buckets` with values in [0, 1] — the
// peak absolute amplitude in each slice. Falls back to a flat zero array
// if the browser can't decode the audio (e.g. Safari + Opus on older
// versions).
export async function computeWaveformPeaks(
  audioBytes: Uint8Array,
  buckets: number = WAVEFORM_BUCKETS,
): Promise<Float32Array> {
  // Copy into a fresh ArrayBuffer — decodeAudioData transfers ownership
  // and detaches the source, which would corrupt the persisted snapshot.
  const buf = audioBytes.slice().buffer;
  const ctx = getAudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(buf);
  } catch {
    return new Float32Array(buckets);
  }

  // Always use channel 0 — we extract mono in audio-extract.ts so this is
  // safe. If a multichannel buffer ever sneaks in, channel 0 still gives a
  // representative peak shape.
  const channel = decoded.getChannelData(0);
  const samplesPerBucket = Math.max(1, Math.floor(channel.length / buckets));
  const peaks = new Float32Array(buckets);
  let max = 0;
  for (let i = 0; i < buckets; i++) {
    const start = i * samplesPerBucket;
    const end = Math.min(channel.length, start + samplesPerBucket);
    let peak = 0;
    for (let j = start; j < end; j++) {
      const v = Math.abs(channel[j]);
      if (v > peak) peak = v;
    }
    peaks[i] = peak;
    if (peak > max) max = peak;
  }
  // Normalize so the loudest peak hits 1.0 — quiet recordings still look
  // like a waveform instead of a flat line.
  if (max > 0) {
    for (let i = 0; i < buckets; i++) peaks[i] /= max;
  }
  return peaks;
}
