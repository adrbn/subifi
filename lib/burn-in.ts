import type { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import { getFFmpeg, resetFFmpeg } from './ffmpeg-client';
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

export class BurnCancelledError extends Error {
  constructor() {
    super('Burn cancelled');
    this.name = 'BurnCancelledError';
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
async function decodeImageToRGBA(dataUrl: string): Promise<{
  rgba: Uint8Array;
  width: number;
  height: number;
}> {
  // Try OffscreenCanvas first (works in Web Workers), fall back to a DOM
  // canvas + <img> if that produces 0 bytes (Safari/some Chrome builds).
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);
    const { width, height } = bitmap;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, width, height);
    bitmap.close();
    const expected = width * height * 4;
    if (imageData.data.length === expected) {
      const rgba = new Uint8Array(expected);
      rgba.set(imageData.data);
      return { rgba, width, height };
    }
    console.warn('[burn] OffscreenCanvas returned wrong size, falling back to DOM canvas');
  } catch (e) {
    console.warn('[burn] OffscreenCanvas failed, falling back to DOM canvas', e);
  }

  // Fallback: load via <img> + regular <canvas>
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const { naturalWidth: width, naturalHeight: height } = img;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, width, height);
      const rgba = new Uint8Array(imageData.data.length);
      rgba.set(imageData.data);
      resolve({ rgba, width, height });
    };
    img.onerror = () => reject(new Error('Failed to decode image'));
    img.src = dataUrl;
  });
}

type OverlayMeta = { name: string; width: number; height: number };

// Build the ffmpeg filter_complex string that chains the subtitle burn with
// N image overlays. Each overlay is a rawvideo input (pre-decoded in JS) so
// we avoid PNG/JPEG decoding inside ffmpeg-wasm's broken threading model.
function buildOverlayComplex(
  overlays: ImageOverlay[],
  overlayMetas: OverlayMeta[],
  subsFilter: string,
  effectiveWidth: number,
  videoSource: string,
  videoDuration: number,
): string {
  const parts: string[] = [`${videoSource}${subsFilter}[v0]`];
  overlays.forEach((ov, i) => {
    const inputIdx = i + 1;
    const scaleW = Math.max(1, Math.round(effectiveWidth * ov.width));
    const alpha = Math.max(0, Math.min(1, ov.opacity));
    const alphaExpr =
      alpha < 0.999
        ? `,colorchannelmixer=aa=${alpha.toFixed(3)}`
        : '';
    // The rawvideo input is already RGBA. Scale to target width, apply
    // alpha if needed. No loop/movie filter required — the input is
    // looped at the demuxer level via -stream_loop.
    parts.push(`[${inputIdx}:v]scale=${scaleW}:-1${alphaExpr}[img${i}]`);

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

// Fetch a Google Font for burning. Strategy:
//   1. /api/font proxy → static TTF from Fontsource / Google CSS scrape.
//      Works for most fonts. The freetype baked into ffmpeg-wasm does NOT
//      include brotli so woff2 silently fails to decode — TTF is required.
//   2. Direct WOFF2 from Google CSS (browser fetch) — last-resort fallback.
//      May not render in the wasm freetype; kept as a heuristic for fonts
//      where no static TTF can be sourced.
async function fetchGoogleFontFile(
  family: string,
  weight: number,
): Promise<{ name: string; buffer: ArrayBuffer } | null> {
  const safe = family.replace(/[^A-Za-z0-9]+/g, '_');
  // Strategy 1: TTF via /api/font proxy (Fontsource → Google CSS scrape)
  try {
    const url = `/api/font?family=${encodeURIComponent(family)}&weight=${weight}`;
    const res = await fetch(url);
    if (res.ok) {
      const buffer = await res.arrayBuffer();
      if (buffer.byteLength > 0) {
        console.debug(`[burn] got TTF for ${family}@${weight} (${buffer.byteLength} bytes)`);
        return { name: `${safe}-${weight}.ttf`, buffer };
      }
    }
  } catch {
    // fall through to woff2
  }
  // Strategy 2: WOFF2 direct from Google Fonts CSS (browser-side).
  // This is the approach the original burn pipeline used and is proven
  // to work with the wasm freetype build.
  try {
    const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(
      family,
    )}:wght@${weight}&display=swap`;
    const cssRes = await fetch(cssUrl, { mode: 'cors' });
    if (cssRes.ok) {
      const css = await cssRes.text();
      const match = css.match(/url\((https:[^)]+\.woff2)\)/);
      if (match) {
        const fontRes = await fetch(match[1], { mode: 'cors' });
        if (fontRes.ok) {
          const buffer = await fontRes.arrayBuffer();
          if (buffer.byteLength > 0) {
            console.debug(
              `[burn] got WOFF2 for ${family}@${weight} (${buffer.byteLength} bytes)`,
            );
            return { name: `${safe}-${weight}.woff2`, buffer };
          }
        }
      }
    }
  } catch {
    // fall through
  }
  console.warn(
    `[burn] could not fetch font for ${family}@${weight} via either TTF or WOFF2`,
  );
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
  // Reset the cancellation flag for this run. A previous burn might have
  // left it set if it was cancelled and the user is starting a fresh one.
  cancelRequested = false;
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
      }
      await ff.writeFile(
        `${fontsDir}/${mainFont.name}`,
        cloneBytesForFFmpeg(mainFont.buffer),
      );
      fontsWritten++;
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

    // Decode each image overlay to raw RGBA pixels in JavaScript and write
    // them as rawvideo files. This completely avoids PNG/JPEG decoding
    // inside ffmpeg-wasm, which deadlocks due to threading issues.
    const overlayMetas: OverlayMeta[] = [];
    for (let i = 0; i < effectiveOverlays.length; i++) {
      const ov = effectiveOverlays[i];
      const decoded = await decodeImageToRGBA(ov.dataUrl);
      const name = `overlay_${i}.raw`;
      await ff.writeFile(name, decoded.rgba);
      overlayNames.push(name);
      overlayMetas.push({ name, width: decoded.width, height: decoded.height });
      console.debug(`[burn] decoded overlay ${i} to raw RGBA: ${decoded.width}x${decoded.height} (${decoded.rgba.byteLength} bytes)`);
    }

    // Auto-cap export resolution to 1080p on the short side. This is the
    // single biggest speed win for phone footage shot at 4K: x264 cost is
    // ~quadratic in pixel count, so 4K → 1080p is ~4x fewer pixels and ~4x
    // faster at essentially no visible quality loss for social export.
    // 1080p and below pass through unchanged. Downscaled dimensions are
    // forced to even so libx264's YUV420 sampling is happy.
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
    const scalePrefix = shouldDownscale
      ? `scale=${effectiveWidth}:${effectiveHeight},`
      : '';
    const subsFilter = `${scalePrefix}subtitles=${subsName}:fontsdir=${fontsDir}`;

    // The video / audio source labels feeding into the rest of the chain.
    // When cuts are present we route everything through the trim+concat
    // prefix's outputs ([vcut] / [acut]); otherwise we use the raw input.
    const vSource = cutPrefix ? cutPrefix.vLabel : '[0:v]';
    const aMap = cutPrefix ? cutPrefix.aLabel : '0:a?';

    // Watchdog: if exec runs for more than `STALL_THRESHOLD_MS` without
    // any progress event, log a warning so we can tell whether the worker
    // is hung in libass init vs. just slowly chewing through frames.
    const STALL_THRESHOLD_MS = 10_000;
    const watchdogStart = Date.now();
    watchdog = setInterval(() => {
      const sinceProgress = Date.now() - lastProgressAt;
      const sinceStart = Date.now() - watchdogStart;
      if (firstProgress && sinceStart > STALL_THRESHOLD_MS) {
        console.warn(
          `[burn] no progress events after ${Math.round(sinceStart / 1000)}s — ` +
            `ffmpeg-wasm may still be initialising or is stuck. ` +
            `Recent log: ${recentLogs.slice(-3).join(' | ')}`,
        );
      } else if (!firstProgress && sinceProgress > STALL_THRESHOLD_MS) {
        console.warn(
          `[burn] last progress event was ${Math.round(sinceProgress / 1000)}s ago — ` +
            `encoding may have stalled.`,
        );
      }
    }, 5_000);

    let exitCode: number;
    // We need filter_complex when we have image overlays OR when cuts
    // require a trim+concat prefix. The simple `-vf` path only works for
    // the no-cuts/no-overlays case because `-vf` and `-filter_complex` are
    // mutually exclusive in ffmpeg.
    if (effectiveOverlays.length > 0 || cutPrefix) {
      const filterParts: string[] = [];
      if (cutPrefix) filterParts.push(cutPrefix.filter);

      if (effectiveOverlays.length > 0) {
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
            effectiveOverlays,
            overlayMetas,
            subsFilter,
            effectiveWidth,
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
        effectiveOverlays.length > 0
          ? `[v${effectiveOverlays.length}]`
          : '[vout]';
      const args: string[] = ['-i', inputName];
      // Each overlay is a raw RGBA file looped via -stream_loop. Using
      // rawvideo avoids the PNG decoder and the associated threading
      // deadlock in ffmpeg-wasm.
      for (const meta of overlayMetas) {
        args.push(
          '-stream_loop', '-1',
          '-f', 'rawvideo',
          '-pixel_format', 'rgba',
          '-video_size', `${meta.width}x${meta.height}`,
          '-framerate', '25',
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
    // .exec() rejection after a terminate() looks like a generic error;
    // promote it to our typed cancellation if a cancel was requested.
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
    // After a cancel the worker has been terminated; ff.off() and the
    // file-deletion calls below would fail. Skip cleanup in that case —
    // resetFFmpeg() (called by cancelBurn) makes sure the next burn loads
    // a fresh worker anyway.
    if (!cancelRequested) {
      ff.off('log', logHandler);
      ff.off('progress', progressHandler);
      // Best-effort cleanup of everything we wrote so subsequent burns start
      // fresh and the wasm FS doesn't grow unbounded.
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
