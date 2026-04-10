import type { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import {
  getFFmpeg,
  resetFFmpeg,
  forceSingleThread,
  isMultiThreaded,
} from './ffmpeg-client';
import { generateAss } from './ass-generator';
import {
  getKeepRanges,
  remapImageOverlays,
  remapSubtitleBlocks,
  remapTextOverlays,
} from './cuts';
import type {
  Cut,
  CustomFont,
  ImageOverlay,
  Style,
  SubtitleBlock,
  TextOverlay,
} from './types';

// Tracks the FFmpeg instance currently running a burn so cancelBurn() can
// terminate the underlying worker. Cleared in the burn's finally block.
let activeFFmpeg: FFmpeg | null = null;
let cancelRequested = false;
// Set when the stall watchdog terminates the worker so the finally block
// knows to skip cleanup (same as cancelRequested but for stall-based abort).
let stallTerminated = false;

export class BurnCancelledError extends Error {
  constructor() {
    super('Burn cancelled');
    this.name = 'BurnCancelledError';
  }
}

// Thrown when ffmpeg exec stalls (no progress events for STALL_ABORT_MS).
// Caught by burnSubtitles() to auto-retry with single-threaded core.
export class BurnStalledError extends Error {
  constructor() {
    super('Burn stalled — ffmpeg worker appears deadlocked');
    this.name = 'BurnStalledError';
  }
}

// Kill the in-flight burn (if any). Safe to call when nothing is running.
// We terminate the worker AND reset the singleton because @ffmpeg/ffmpeg's
// FFmpeg instance is unusable after .terminate() — the next burn must load
// a fresh core/worker.
export function cancelBurn(): void {
  cancelRequested = true;
  const ff = activeFFmpeg;
  if (!ff) return;
  try {
    ff.terminate();
  } catch {
    // ignore — terminate() may throw if the worker already died
  }
  activeFFmpeg = null;
  resetFFmpeg();
}

// Burns styled subtitles into the source video using libass via ffmpeg's
// `subtitles` filter. Output is MP4 / H.264 / AAC.

export type BurnProgress = (ratio: number) => void;

export type BurnInput = {
  videoFile: File;
  blocks: SubtitleBlock[];
  style: Style;
  videoWidth: number;
  videoHeight: number;
  customFonts: CustomFont[];
  overlays?: ImageOverlay[];
  textOverlays?: TextOverlay[];
  // Optional cut list — segments to remove from the source. When non-empty
  // the burn pipeline first stitches together the inverse "keep ranges"
  // via ffmpeg trim+concat, then applies subtitles + overlays. Subtitle
  // and text overlay timings are remapped to the post-cut timeline before
  // generating the ASS file so they line up with the trimmed video.
  cuts?: Cut[];
  // Original video duration in seconds — used to compute keep ranges. Only
  // required when `cuts` is non-empty; falls back to ignoring cuts if not
  // provided.
  videoDuration?: number;
};

// Keep the last N stderr lines so we can include them in error messages.
// 50 lines is enough to surface the actual ffmpeg error without flooding
// the UI.
const MAX_LOG_LINES = 50;

// Turn a data: URL into raw bytes so we can write it to the ffmpeg FS.
function dataUrlToBytes(dataUrl: string): Uint8Array {
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx < 0) throw new Error('Invalid data URL');
  const header = dataUrl.slice(0, commaIdx);
  const payload = dataUrl.slice(commaIdx + 1);
  if (header.includes(';base64')) {
    const bin = atob(payload);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new TextEncoder().encode(decodeURIComponent(payload));
}

// Copy bytes into a brand-new ArrayBuffer before handing them to ffmpeg.
//
// CRITICAL: @ffmpeg/ffmpeg's writeFile() passes `data.buffer` as a postMessage
// Transferable (see node_modules/@ffmpeg/ffmpeg/dist/esm/classes.js — the
// writeFile method does `trans.push(data.buffer)`). That DETACHES the
// underlying ArrayBuffer on the main thread. If we pass a view over a
// long-lived buffer (e.g. customFonts[i].buffer in the editor store), the
// next access throws "Cannot perform Construct on a detached ArrayBuffer"
// and every subsequent burn fails at 0%. This helper allocates a fresh
// buffer + copies the bytes so the original stays intact across burns.
function cloneBytesForFFmpeg(source: ArrayBuffer | Uint8Array): Uint8Array {
  const view = source instanceof Uint8Array ? source : new Uint8Array(source);
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy;
}

// True if an ArrayBuffer has been detached (e.g. transferred to a worker).
// Detached buffers report byteLength === 0, but since 0-length is also a
// valid intact buffer, we use a probe constructor inside try/catch.
function isDetached(buffer: ArrayBuffer): boolean {
  try {
    // new Uint8Array on a detached buffer throws TypeError "Cannot perform
    // Construct on a detached ArrayBuffer". On an intact buffer it succeeds
    // even at zero length.
    new Uint8Array(buffer, 0, 0);
    return false;
  } catch {
    return true;
  }
}

// Read the font family name from a TTF/OTF name table. libass matches fonts
// by the INTERNAL family name, not the filename. If this doesn't match what
// the ASS Style line says, subtitles render invisible. Returns null on any
// parse error — caller should fall back to the display name.
function readFontFamilyName(buf: ArrayBuffer): string | null {
  try {
    const view = new DataView(buf);
    if (buf.byteLength < 12) return null;
    const numTables = view.getUint16(4);
    let nameOffset = 0;
    for (let i = 0; i < numTables; i++) {
      const off = 12 + i * 16;
      if (off + 16 > buf.byteLength) break;
      const tag =
        String.fromCharCode(view.getUint8(off)) +
        String.fromCharCode(view.getUint8(off + 1)) +
        String.fromCharCode(view.getUint8(off + 2)) +
        String.fromCharCode(view.getUint8(off + 3));
      if (tag === 'name') {
        nameOffset = view.getUint32(off + 8);
        break;
      }
    }
    if (nameOffset === 0 || nameOffset + 6 > buf.byteLength) return null;

    const count = view.getUint16(nameOffset + 2);
    const storageOffset = nameOffset + view.getUint16(nameOffset + 4);

    // Prefer Name ID 1 (Family) on platform 3 (Windows) encoding 1 (Unicode BMP).
    // Also try platform 1 (Mac) as fallback.
    let family: string | null = null;
    for (let i = 0; i < count; i++) {
      const rec = nameOffset + 6 + i * 12;
      if (rec + 12 > buf.byteLength) break;
      const platformID = view.getUint16(rec);
      const encodingID = view.getUint16(rec + 2);
      const nameID = view.getUint16(rec + 6);
      const length = view.getUint16(rec + 8);
      const strOff = view.getUint16(rec + 10);
      if (nameID !== 1) continue;
      const start = storageOffset + strOff;
      if (start + length > buf.byteLength) continue;
      if (platformID === 3 && encodingID === 1) {
        // UTF-16 BE
        const chars: number[] = [];
        for (let j = 0; j < length; j += 2) chars.push(view.getUint16(start + j));
        return String.fromCharCode(...chars);
      }
      if (platformID === 1 && !family) {
        // Mac Roman — ASCII-ish
        const bytes: number[] = [];
        for (let j = 0; j < length; j++) bytes.push(view.getUint8(start + j));
        family = String.fromCharCode(...bytes);
      }
    }
    return family;
  } catch {
    return null;
  }
}

// Detect characters outside Latin/Latin-Extended that need a fallback font
// in the burn. Returns a list of { family, subset, weight } to fetch.
// Currently supports CJK (Chinese/Japanese/Korean).
const CJK_RANGE =
  /[\u2E80-\u9FFF\uF900-\uFAFF\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/;

type FallbackFontSpec = {
  family: string;
  subset: string;
  weight: number;
};

function detectNeededFallbacks(
  allText: string,
  weight: number,
): FallbackFontSpec[] {
  const specs: FallbackFontSpec[] = [];
  if (CJK_RANGE.test(allText)) {
    specs.push({
      family: 'Noto Sans SC',
      subset: 'chinese-simplified',
      weight: Math.min(weight, 700), // Noto Sans SC has 100-900
    });
  }
  return specs;
}

function extForMime(mime: string): string {
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('svg')) return 'svg';
  return 'png';
}

// Decode a data-URL image to raw RGBA pixels using OffscreenCanvas. This
// lets us feed images to ffmpeg as rawvideo, completely sidestepping the
// PNG/JPEG decoder threading issues that cause deadlocks in ffmpeg-wasm.
// Decode and pre-scale an image overlay to raw RGBA at the exact pixel
// dimensions it will occupy in the output video. Returning the frame at
// final size lets us skip the `scale` filter in ffmpeg AND means we can
// duplicate the small frame to fill the video duration without using
// `-stream_loop` (which deadlocks in ffmpeg-wasm).
//
// Uses a DOM <img> + <canvas> (reliable on all browsers including mobile
// Safari) rather than OffscreenCanvas whose 2D context is broken on some
// mobile builds and silently returns empty ImageData.
async function decodeImageScaled(
  dataUrl: string,
  targetWidth: number,
): Promise<{ rgba: Uint8Array; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const { naturalWidth, naturalHeight } = img;
      const w = Math.max(1, Math.round(targetWidth));
      const h = Math.max(1, Math.round((naturalHeight / naturalWidth) * w));
      // Force even dimensions for YUV compat
      const fw = w % 2 === 0 ? w : w + 1;
      const fh = h % 2 === 0 ? h : h + 1;
      const canvas = document.createElement('canvas');
      canvas.width = fw;
      canvas.height = fh;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, fw, fh);
      const imageData = ctx.getImageData(0, 0, fw, fh);
      const rgba = new Uint8Array(imageData.data.length);
      rgba.set(imageData.data);
      console.debug(`[burn] decoded+scaled image: ${naturalWidth}x${naturalHeight} → ${fw}x${fh} (${rgba.byteLength} bytes/frame)`);
      resolve({ rgba, width: fw, height: fh });
    };
    img.onerror = () => reject(new Error('Failed to decode image overlay'));
    img.src = dataUrl;
  });
}

type OverlayMeta = { name: string; width: number; height: number };

// Build the ffmpeg filter_complex string that chains the subtitle burn with
// N image overlays. Images are pre-scaled in JS so no scale filter is needed.
function buildOverlayComplex(
  overlays: ImageOverlay[],
  overlayMetas: OverlayMeta[],
  subsFilter: string,
  videoSource: string,
  videoDuration: number,
): string {
  const parts: string[] = [`${videoSource}${subsFilter}[v0]`];
  overlays.forEach((ov, i) => {
    const inputIdx = i + 1;
    const alpha = Math.max(0, Math.min(1, ov.opacity));
    const alphaExpr =
      alpha < 0.999
        ? `[${inputIdx}:v]colorchannelmixer=aa=${alpha.toFixed(3)}[img${i}]`
        : `[${inputIdx}:v]null[img${i}]`;
    // Image is pre-scaled in JS — no scale filter needed. Just apply
    // alpha if required.
    parts.push(alphaExpr);

    const posX = `(main_w*${ov.positionX.toFixed(4)})-(overlay_w/2)`;
    const posY = `(main_h*${ov.positionY.toFixed(4)})-(overlay_h/2)`;

    const isFullDuration =
      ov.start <= 0.1 && ov.end >= videoDuration - 0.1;

    if (isFullDuration) {
      parts.push(`[v${i}][img${i}]overlay=${posX}:${posY}:shortest=1[v${i + 1}]`);
    } else {
      const s = ov.start.toFixed(3);
      const e = ov.end.toFixed(3);
      const gate = `gte(t,${s})*lte(t,${e})`;
      const xExpr = `'if(${gate},${posX},-main_w*2)'`;
      const yExpr = `'if(${gate},${posY},-main_h*2)'`;
      parts.push(
        `[v${i}][img${i}]overlay=x=${xExpr}:y=${yExpr}:eval=frame:shortest=1[v${i + 1}]`,
      );
    }
  });
  return parts.join(';');
}

// Fetch a Google Font for burning as a TTF via the /api/font proxy.
// The proxy tries Fontsource (jsdelivr CDN) first, then Google CSS scrape
// with a legacy UA that triggers TTF responses.
//
// IMPORTANT: We ONLY accept TTF. The freetype build baked into ffmpeg-wasm
// does NOT include brotli, so WOFF2 fonts silently fail to decode. If we
// wrote a WOFF2 file to fontsdir, libass would skip it and fall back to a
// built-in font — causing the "wrong font in export" bug. Better to return
// null and let the caller surface a clear error.
async function fetchGoogleFontFile(
  family: string,
  weight: number,
  subset?: string,
): Promise<{ name: string; buffer: ArrayBuffer } | null> {
  const safe = family.replace(/[^A-Za-z0-9]+/g, '_');
  try {
    let url = `/api/font?family=${encodeURIComponent(family)}&weight=${weight}`;
    if (subset) url += `&subset=${encodeURIComponent(subset)}`;
    const res = await fetch(url);
    if (res.ok) {
      const buffer = await res.arrayBuffer();
      if (buffer.byteLength > 0) {
        // Quick TTF magic-number sanity check: real TTF starts with
        // 0x00010000, 'true', or 'OTTO' (OTF/CFF).
        const sig = new DataView(buffer).getUint32(0);
        const isTTF =
          sig === 0x00010000 ||
          sig === 0x74727565 || // 'true'
          sig === 0x4f54544f;   // 'OTTO'
        if (!isTTF) {
          console.warn(
            `[burn] /api/font returned non-TTF data for ${family}@${weight} ` +
              `(sig=0x${sig.toString(16)}, ${buffer.byteLength} bytes) — skipping`,
          );
          return null;
        }
        console.debug(
          `[burn] got TTF for ${family}@${weight} (${buffer.byteLength} bytes)`,
        );
        return { name: `${safe}-${weight}.ttf`, buffer };
      }
    } else {
      console.warn(
        `[burn] /api/font returned ${res.status} for ${family}@${weight}`,
      );
    }
  } catch (err) {
    console.warn(`[burn] font fetch failed for ${family}@${weight}`, err);
  }
  return null;
}

// Build the trim+concat filter chain that turns a single source video
// into a stitched stream of just the keep-ranges. Returns null when there
// are no cuts (caller should fall through to the original "no-cut" path).
//
// The output labels are `[vcut]` and `[acut]` so the rest of the pipeline
// can keep using a single naming scheme regardless of whether cuts were
// applied. We always emit BOTH labels — silent videos won't reach this
// code path because audio extraction is required to even open the burn
// dialog.
function buildCutPrefix(
  cuts: Cut[],
  duration: number,
): { filter: string; vLabel: string; aLabel: string } | null {
  const keeps = getKeepRanges(cuts, duration);
  if (
    keeps.length === 0 ||
    (keeps.length === 1 && keeps[0].start === 0 && keeps[0].end === duration)
  ) {
    return null;
  }
  const parts: string[] = [];
  for (let i = 0; i < keeps.length; i++) {
    const k = keeps[i];
    parts.push(
      `[0:v]trim=start=${k.start.toFixed(3)}:end=${k.end.toFixed(3)},setpts=PTS-STARTPTS[vk${i}]`,
    );
    parts.push(
      `[0:a]atrim=start=${k.start.toFixed(3)}:end=${k.end.toFixed(3)},asetpts=PTS-STARTPTS[ak${i}]`,
    );
  }
  // Build the concat input list: [vk0][ak0][vk1][ak1]...
  const concatInputs = keeps
    .map((_, i) => `[vk${i}][ak${i}]`)
    .join('');
  parts.push(`${concatInputs}concat=n=${keeps.length}:v=1:a=1[vcut][acut]`);
  return { filter: parts.join(';'), vLabel: '[vcut]', aLabel: '[acut]' };
}

export async function burnSubtitles(
  input: BurnInput,
  onProgress?: BurnProgress,
): Promise<Uint8Array> {
  try {
    return await burnSubtitlesCore(input, onProgress);
  } catch (err) {
    // If the burn stalled, switch to single-threaded core and retry once.
    // This handles the common case where @ffmpeg/core-mt deadlocks on
    // Windows during libass rendering. forceSingleThread() is idempotent
    // so calling it when already in ST mode is a no-op.
    if (err instanceof BurnStalledError) {
      console.warn(
        '[burn] stall detected — switching to single-threaded core and retrying',
      );
      forceSingleThread();
      onProgress?.(0);
      return await burnSubtitlesCore(input, onProgress);
    }
    throw err;
  }
}

async function burnSubtitlesCore(
  input: BurnInput,
  onProgress?: BurnProgress,
): Promise<Uint8Array> {
  const {
    videoFile,
    blocks,
    style,
    videoWidth,
    videoHeight,
    customFonts,
    overlays = [],
    textOverlays = [],
    cuts = [],
    videoDuration = 0,
  } = input;
  // Reset the cancellation / stall flags for this run.
  cancelRequested = false;
  stallTerminated = false;
  const ff = await getFFmpeg();
  activeFFmpeg = ff;

  // Capture ffmpeg's stderr into a rotating buffer so we can show the user
  // (and ourselves) the actual reason a burn failed. Without this, exec()
  // returning a non-zero exit code is the only signal we get and it's
  // useless on its own.
  const recentLogs: string[] = [];
  const logHandler = ({ message }: { message: string }) => {
    recentLogs.push(message);
    if (recentLogs.length > MAX_LOG_LINES) recentLogs.shift();
  };
  ff.on('log', logHandler);

  // Wrap the user's progress callback so we can ALSO log the first few
  // ticks. The "blocked at 0%" reports usually turn out to be one of:
  //   (a) ffmpeg is still in libass / filter init and no frames have been
  //       encoded yet — so the progress event hasn't fired,
  //   (b) ffmpeg is genuinely hung in libass while parsing the embedded
  //       [Fonts] section,
  //   (c) the burn is fine but slow — wasm x264 ultrafast on a 3-min clip
  //       can take 30-60s before the first progress tick.
  // The watchdog below distinguishes (a)/(c) from (b): if no progress
  // event fires for 20s after exec started, we log a warning so the user
  // knows it's still alive.
  let firstProgress = true;
  let lastProgressAt = Date.now();
  const progressHandler = ({ progress, time }: { progress: number; time: number }) => {
    lastProgressAt = Date.now();
    // ffmpeg-wasm's `progress` field is unreliable (can be negative, >1,
    // or stuck at 0). When we know the video duration, compute progress
    // from the `time` field (microseconds) for a smooth, accurate bar.
    let p = progress;
    if (videoDuration > 0 && time > 0) {
      p = (time / 1_000_000) / videoDuration;
    }

    // FAST GARBAGE DETECTION: On Windows, @ffmpeg/core-mt produces a
    // corrupt `time` value (e.g. 577014 hours) on the very first progress
    // event, causing progress to jump to >100%. Detect this instantly and
    // abort — no need to wait for the 30s stall timeout.
    if (firstProgress && p > 1.5 && !stallTerminated) {
      console.error(
        `[burn] garbage progress on first event — MT core broken. ` +
          `time=${time}, computed=${p.toFixed(1)}, duration=${videoDuration}. Aborting.`,
      );
      stallTerminated = true;
      try {
        ff.terminate();
      } catch {
        // ignore
      }
      if (activeFFmpeg === ff) activeFFmpeg = null;
      resetFFmpeg();
      return;
    }

    if (firstProgress) {
      console.debug('[burn] first progress event', { progress, time, computed: p });
      firstProgress = false;
    }
    onProgress?.(Math.max(0, Math.min(1, p)));
  };
  ff.on('progress', progressHandler);

  const inputName = 'in.mp4';
  const subsName = 'subs.ass';
  const outputName = 'out.mp4';
  const fontsDir = 'fonts';

  // Track everything we wrote so the cleanup pass in `finally` actually
  // catches it even when we throw mid-pipeline.
  const overlayNames: string[] = [];
  // Watchdog handle is captured at function scope so the finally block can
  // always clear it, even if we throw before exec starts.
  let watchdog: ReturnType<typeof setInterval> | null = null;

  // Pre-compute the cut prefix once. When present we also have to remap
  // every block and text overlay onto the post-cut timeline so the
  // generated ASS lines up with the trimmed video.
  const cutPrefix =
    cuts.length > 0 && videoDuration > 0
      ? buildCutPrefix(cuts, videoDuration)
      : null;
  const effectiveBlocks = cutPrefix
    ? remapSubtitleBlocks(blocks, cuts, videoDuration)
    : blocks;
  const effectiveTextOverlays = cutPrefix
    ? remapTextOverlays(textOverlays, cuts, videoDuration)
    : textOverlays;
  // Image overlays also carry start/end now, so they need the same
  // post-cut timeline remap as text overlays / subtitle blocks. The
  // remapped list is what we hand to buildOverlayComplex below — both for
  // the input order and the `enable=` time window.
  const effectiveOverlays = cutPrefix
    ? remapImageOverlays(overlays, cuts, videoDuration)
    : overlays;

  // Diagnostic dump — surfaced via console.debug so it's there when the
  // user complains "subtitles not burned" but doesn't drown the console
  // in normal operation. Includes ALL the things that historically went
  // wrong silently: empty blocks after cuts, missing fonts, etc.
  console.debug('[burn] starting', {
    mode: isMultiThreaded() ? 'multi-threaded' : 'single-threaded',
    blocks: blocks.length,
    effectiveBlocks: effectiveBlocks.length,
    textOverlays: textOverlays.length,
    overlays: overlays.length,
    effectiveOverlays: effectiveOverlays.length,
    customFonts: customFonts.length,
    cuts: cuts.length,
    cutsActive: cutPrefix !== null,
    fontFamily: style.fontFamily,
    fontWeight: style.fontWeight,
    videoSize: `${videoWidth}x${videoHeight}`,
  });

  try {
    // Write input video.
    await ff.writeFile(inputName, await fetchFile(videoFile));

    // --- Fetch fonts FIRST so we can read their internal family names ---
    // libass matches fonts by the INTERNAL name table, not the filename.
    // If the TTF's internal name differs from the display name the user
    // chose (e.g. "Inter Variable" vs "Inter"), subtitles render invisible.
    // We build a fontNameMap: displayName → internalName, then pass the
    // remapped names to generateAss so the ASS Style lines always match.
    try {
      await ff.createDir(fontsDir);
    } catch {
      // may already exist
    }

    const fontNameMap = new Map<string, string>();
    let fontsWritten = 0;

    // Custom user-uploaded fonts.
    for (const f of customFonts) {
      if (isDetached(f.buffer)) {
        console.warn(
          `[burn] custom font "${f.name}" has a detached buffer — skipping.`,
        );
        continue;
      }
      const internal = readFontFamilyName(f.buffer);
      if (internal) fontNameMap.set(f.name, internal);
      await ff.writeFile(
        `${fontsDir}/${f.name}.${f.format}`,
        cloneBytesForFFmpeg(f.buffer),
      );
      fontsWritten++;
    }

    // Google Font for the main subtitle style.
    const mainFont = await fetchGoogleFontFile(
      style.fontFamily,
      style.fontWeight,
    );
    if (mainFont) {
      const internal = readFontFamilyName(mainFont.buffer);
      if (internal) {
        fontNameMap.set(style.fontFamily, internal);
        console.debug(`[burn] font name remap: "${style.fontFamily}" → "${internal}"`);
      } else {
        console.warn(
          `[burn] could not read internal name from TTF for "${style.fontFamily}" — ` +
            `libass will try to match by the display name, which may fail`,
        );
      }
      await ff.writeFile(
        `${fontsDir}/${mainFont.name}`,
        cloneBytesForFFmpeg(mainFont.buffer),
      );
      fontsWritten++;
    } else {
      console.warn(
        `[burn] no TTF available for main font "${style.fontFamily}" @ ${style.fontWeight}. ` +
          `Subtitles will render with libass built-in fallback font.`,
      );
    }

    // Text overlay fonts (deduplicated).
    const seen = new Set<string>([`${style.fontFamily}@${style.fontWeight}`]);
    for (const t of textOverlays) {
      const key = `${t.fontFamily}@${t.fontWeight}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const f = await fetchGoogleFontFile(t.fontFamily, t.fontWeight);
      if (f) {
        const internal = readFontFamilyName(f.buffer);
        if (internal) fontNameMap.set(t.fontFamily, internal);
        await ff.writeFile(
          `${fontsDir}/${f.name}`,
          cloneBytesForFFmpeg(f.buffer),
        );
        fontsWritten++;
      }
    }
    // CJK / non-Latin fallback fonts. Scan ALL text (subtitles + overlays)
    // for characters the main font can't render (e.g. Chinese, Japanese,
    // Korean). For each detected script, fetch a known-good fallback font
    // (e.g. Noto Sans SC for CJK) with the appropriate subset.
    const allText =
      effectiveBlocks.map((b) => b.text).join('') +
      effectiveTextOverlays.map((t) => t.text).join('');
    const fallbackSpecs = detectNeededFallbacks(allText, style.fontWeight);
    // Maps script regex → internal font family name so generateAss can
    // wrap character runs with {\fn<name>} overrides.
    const fallbackFonts = new Map<string, string>();
    for (const spec of fallbackSpecs) {
      const key = `${spec.family}@${spec.weight}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const f = await fetchGoogleFontFile(spec.family, spec.weight, spec.subset);
      if (f) {
        const internal = readFontFamilyName(f.buffer);
        const resolvedName = internal ?? spec.family;
        if (internal) fontNameMap.set(spec.family, internal);
        await ff.writeFile(
          `${fontsDir}/${f.name}`,
          cloneBytesForFFmpeg(f.buffer),
        );
        fontsWritten++;
        // CJK_RANGE is the only script we currently detect — map it.
        if (spec.subset === 'chinese-simplified') {
          fallbackFonts.set('cjk', resolvedName);
        }
        console.debug(`[burn] fallback font "${spec.family}" → "${resolvedName}" (${spec.subset})`);
      } else {
        console.warn(
          `[burn] could not fetch fallback font "${spec.family}" (${spec.subset}) — ` +
            `characters in this range will show as rectangles`,
        );
      }
    }

    console.debug('[burn] fonts written to fontsdir', { fontsWritten, fontNameMap: Object.fromEntries(fontNameMap) });
    if (fontsWritten === 0) {
      throw new Error(
        'No fonts could be loaded for burning. Check that the selected font ' +
          `("${style.fontFamily}") is available in our /api/font proxy or ` +
          'upload it as a custom font, then try again.',
      );
    }

    // --- Generate the ASS file with remapped font names ---
    const remap = (name: string) => fontNameMap.get(name) ?? name;
    const assContent = generateAss({
      blocks: effectiveBlocks,
      style: { ...style, fontFamily: remap(style.fontFamily) },
      videoWidth,
      videoHeight,
      textOverlays: effectiveTextOverlays.map((t) => ({
        ...t,
        fontFamily: remap(t.fontFamily),
      })),
      fallbackFonts: Object.fromEntries(fallbackFonts),
    });
    const dialogueCount = (assContent.match(/^Dialogue:/gm) ?? []).length;
    console.debug('[burn] ass file generated', {
      bytes: assContent.length,
      dialogueLines: dialogueCount,
      head: assContent.slice(0, 500),
    });
    if (dialogueCount === 0) {
      throw new Error(
        'Nothing to burn: the generated subtitle file has no Dialogue lines. ' +
          'This usually means all subtitle blocks were removed by cuts, or the ' +
          'block list is empty. Add subtitles or remove the cuts and try again.',
      );
    }
    await ff.writeFile(subsName, new TextEncoder().encode(assContent));

    // Auto-cap export resolution to 1080p on the short side. Computed
    // BEFORE overlays so we pre-scale overlay images to the effective
    // (post-downscale) dimensions, not the original 4K size.
    const MAX_SHORT_SIDE = 1080;
    const shortSide = Math.min(videoWidth, videoHeight);
    const shouldDownscale = shortSide > MAX_SHORT_SIDE;
    const scaleRatio = shouldDownscale ? MAX_SHORT_SIDE / shortSide : 1;
    const effectiveWidth = shouldDownscale
      ? Math.max(2, Math.round((videoWidth * scaleRatio) / 2) * 2)
      : videoWidth;
    const effectiveHeight = shouldDownscale
      ? Math.max(2, Math.round((videoHeight * scaleRatio) / 2) * 2)
      : videoHeight;
    // Subtitles are rendered BEFORE downscale (at native resolution) so
    // PlayRes matches exactly — no rounding or font-metric drift. The
    // scale filter comes AFTER subtitles. Overlays are applied after the
    // scale and are pre-scaled to the effective dimensions.
    const scaleSuffix = shouldDownscale
      ? `,scale=${effectiveWidth}:${effectiveHeight}`
      : '';
    const subsFilter = `subtitles=${subsName}:fontsdir=${fontsDir}${scaleSuffix}`;

    // Decode each image overlay, pre-scale to its final pixel size in JS,
    // then write enough duplicate raw RGBA frames to cover the video
    // duration at 1fps. This avoids:
    //   - PNG decoding inside ffmpeg-wasm (threading deadlock)
    //   - `-stream_loop` on rawvideo (stalls in wasm)
    // At 1fps the overlay filter holds each frame for 1s — perfect for
    // static images. Memory cost: ~(W×H×4×duration_s) per overlay, which
    // for a 200×150 overlay on a 3-minute video ≈ 21 MB.
    // NOTE: overlays are pre-scaled to the EFFECTIVE (post-downscale)
    // dimensions since the overlay filter runs after the scale.
    const OVERLAY_FPS = 1;
    const overlayMetas: OverlayMeta[] = [];
    const decodedOverlays: ImageOverlay[] = [];
    for (let i = 0; i < effectiveOverlays.length; i++) {
      const ov = effectiveOverlays[i];
      const scaleW = Math.max(1, Math.round(effectiveWidth * ov.width));
      const decoded = await decodeImageScaled(ov.dataUrl, scaleW);
      if (decoded.rgba.byteLength === 0) {
        console.error(`[burn] overlay ${i} decoded to 0 bytes — skipping`);
        continue;
      }
      const frameCount = Math.max(1, Math.ceil(videoDuration * OVERLAY_FPS) + 1);
      const frameBytes = decoded.rgba.byteLength;
      const totalBytes = frameCount * frameBytes;
      const buf = new Uint8Array(totalBytes);
      for (let f = 0; f < frameCount; f++) {
        buf.set(decoded.rgba, f * frameBytes);
      }
      const name = `overlay_${i}.raw`;
      await ff.writeFile(name, buf);
      overlayNames.push(name);
      overlayMetas.push({ name, width: decoded.width, height: decoded.height });
      decodedOverlays.push(ov);
      console.debug(`[burn] overlay ${i}: ${decoded.width}x${decoded.height}, ${frameCount} frames @ ${OVERLAY_FPS}fps (${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);
    }

    // The video / audio source labels feeding into the rest of the chain.
    // When cuts are present we route everything through the trim+concat
    // prefix's outputs ([vcut] / [acut]); otherwise we use the raw input.
    const vSource = cutPrefix ? cutPrefix.vLabel : '[0:v]';
    const aMap = cutPrefix ? cutPrefix.aLabel : '0:a?';

    // Watchdog: detects two kinds of stall:
    //   (a) No progress event at all for STALL_WARN_MS → log a warning.
    //   (b) No progress event for STALL_ABORT_MS → assume deadlock (common
    //       with @ffmpeg/core-mt on Windows), terminate the worker and throw
    //       BurnStalledError. The outer burnSubtitles() wrapper catches this
    //       and auto-retries with the single-threaded core.
    const STALL_WARN_MS = 10_000;
    const STALL_ABORT_MS = 30_000;
    const watchdogStart = Date.now();
    watchdog = setInterval(() => {
      // Garbage detection (in progressHandler) may have already terminated.
      if (stallTerminated) return;

      const sinceProgress = Date.now() - lastProgressAt;
      const sinceStart = Date.now() - watchdogStart;
      const elapsed = firstProgress ? sinceStart : sinceProgress;

      if (elapsed > STALL_ABORT_MS) {
        console.error(
          `[burn] stall detected after ${Math.round(elapsed / 1000)}s — ` +
            `terminating ffmpeg worker. Mode: ${isMultiThreaded() ? 'MT' : 'ST'}. ` +
            `Recent log: ${recentLogs.slice(-3).join(' | ')}`,
        );
        stallTerminated = true;
        try {
          ff.terminate();
        } catch {
          // ignore
        }
        if (activeFFmpeg === ff) activeFFmpeg = null;
        resetFFmpeg();
        return;
      }
      if (elapsed > STALL_WARN_MS) {
        console.warn(
          `[burn] ${firstProgress ? 'no progress events' : 'last progress event was'} ` +
            `${Math.round(elapsed / 1000)}s ago — ` +
            `ffmpeg-wasm may still be initialising or is stuck. ` +
            `Recent log: ${recentLogs.slice(-3).join(' | ')}`,
        );
      }
    }, 5_000);

    let exitCode: number;
    // We need filter_complex when we have image overlays OR when cuts
    // require a trim+concat prefix. The simple `-vf` path only works for
    // the no-cuts/no-overlays case because `-vf` and `-filter_complex` are
    // mutually exclusive in ffmpeg.
    if (decodedOverlays.length > 0 || cutPrefix) {
      const filterParts: string[] = [];
      if (cutPrefix) filterParts.push(cutPrefix.filter);

      if (decodedOverlays.length > 0) {
        // Effective duration after cuts — needed for the full-duration
        // optimisation in buildOverlayComplex.
        const effectiveDuration = cutPrefix
          ? getKeepRanges(cuts, videoDuration).reduce(
              (sum, k) => sum + (k.end - k.start),
              0,
            )
          : videoDuration;
        filterParts.push(
          buildOverlayComplex(
            decodedOverlays,
            overlayMetas,
            subsFilter,
            vSource,
            effectiveDuration,
          ),
        );
      } else {
        // Cuts but no image overlays — apply subs directly to the cut
        // output.
        filterParts.push(
          `${vSource}${subsFilter}[vout]`,
        );
      }

      const fullComplex = filterParts.join(';');
      // Map to the last label produced by the overlay chain, or [vout]
      // when there are no overlays.
      const finalLabel =
        decodedOverlays.length > 0
          ? `[v${decodedOverlays.length}]`
          : '[vout]';
      const args: string[] = ['-i', inputName];
      // Each overlay is a pre-scaled raw RGBA file with enough duplicate
      // frames at 1fps to cover the video duration. No -stream_loop needed.
      for (const meta of overlayMetas) {
        args.push(
          '-f', 'rawvideo',
          '-pixel_format', 'rgba',
          '-video_size', `${meta.width}x${meta.height}`,
          '-framerate', String(OVERLAY_FPS),
          '-i', meta.name,
        );
      }
      args.push(
        '-filter_complex',
        fullComplex,
        '-map',
        finalLabel,
        '-map',
        aMap,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '23',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        outputName,
      );
      console.debug('[burn] exec args', args.join(' '));
      exitCode = await ff.exec(args);
    } else {
      const args = [
        '-i',
        inputName,
        '-vf',
        subsFilter,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '23',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        outputName,
      ];
      console.debug('[burn] exec args', args.join(' '));
      exitCode = await ff.exec(args);
    }
    if (watchdog) {
      clearInterval(watchdog);
      watchdog = null;
    }
    console.debug('[burn] ffmpeg.exec resolved', {
      exitCode,
      elapsedMs: Date.now() - watchdogStart,
      sawProgress: !firstProgress,
    });

    if (cancelRequested) {
      throw new BurnCancelledError();
    }

    if (exitCode !== 0) {
      // exit code != 0 after a cancel-triggered terminate is expected. Map
      // it to a clean cancellation error so the UI doesn't show a scary
      // "ffmpeg failed" message for what was a user-initiated stop.
      if (cancelRequested) throw new BurnCancelledError();
      const tail = recentLogs.slice(-15).join('\n');
      throw new Error(
        `ffmpeg burn failed (exit ${exitCode}). Last messages:\n${tail}`,
      );
    }

    // ffmpeg returned 0, but libass can fail SILENTLY when it can't load
    // any usable font for the requested family — the burn completes but the
    // output video has no visible subtitles. This is the #1 source of
    // "subtitles still not burned" reports. Scan stderr for the libass
    // patterns that indicate font trouble and surface them in the console
    // so we (and the user) can see what actually happened.
    const subsRelatedLogs = recentLogs.filter((line) =>
      /fontselect|libass|subtitles|ass:|missing glyph|no fonts|fontconfig/i.test(
        line,
      ),
    );
    if (subsRelatedLogs.length > 0) {
      console.debug('[burn] libass-related stderr lines:', subsRelatedLogs);
    }
    const fontFailures = recentLogs.filter((line) =>
      /fontselect: no.*matching|font.*not found|no fonts|missing font|cannot find.*font/i.test(
        line,
      ),
    );
    if (fontFailures.length > 0) {
      console.warn(
        '[burn] libass reported font matching failures — subtitles may be ' +
          'invisible in the output. Affected lines:',
        fontFailures,
      );
    }

    const data = await ff.readFile(outputName);
    return data as Uint8Array;
  } catch (err) {
    // Stall-triggered terminate: promote to BurnStalledError so the outer
    // burnSubtitles() wrapper can catch it and retry with single-threaded.
    if (stallTerminated && !(err instanceof BurnStalledError)) {
      throw new BurnStalledError();
    }
    // .exec() rejection after a cancel-triggered terminate is expected.
    if (cancelRequested && !(err instanceof BurnCancelledError)) {
      throw new BurnCancelledError();
    }
    throw err;
  } finally {
    if (watchdog) {
      clearInterval(watchdog);
      watchdog = null;
    }
    if (activeFFmpeg === ff) activeFFmpeg = null;
    // After a cancel or stall-terminate the worker is dead; ff.off() and
    // file-deletion would fail. Skip cleanup — resetFFmpeg() ensures the
    // next burn loads a fresh worker anyway.
    if (!cancelRequested && !stallTerminated) {
      ff.off('log', logHandler);
      ff.off('progress', progressHandler);
      for (const name of [inputName, subsName, outputName, ...overlayNames]) {
        try {
          await ff.deleteFile(name);
        } catch {
          // ignore — file may not exist if we threw before writing it
        }
      }
    }
  }
}
