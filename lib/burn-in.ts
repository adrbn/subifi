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

function extForMime(mime: string): string {
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('svg')) return 'svg';
  return 'png';
}

// Build the ffmpeg filter_complex string that chains the subtitle burn with
// N image overlays. Each overlay is a separate ffmpeg input (indices 1..N)
// and is center-anchored using ffmpeg overlay expressions so it matches the
// DOM preview's positioning. `effectiveWidth` is the width of the main video
// AFTER any pre-subs downscale — it's what overlay widths must be computed
// against so their on-screen fraction matches the preview.
function buildOverlayComplex(
  overlays: ImageOverlay[],
  subsFilter: string,
  effectiveWidth: number,
  videoSource: string,
): string {
  // First step: run the subs filter on the upstream video source (either
  // [0:v] or the cut prefix's [vcut]) and emit it as [v0]. The image
  // overlay chain then walks [v0]→[v1]→…→[vN] one overlay at a time.
  const parts: string[] = [`${videoSource}${subsFilter}[v0]`];
  overlays.forEach((ov, i) => {
    const inputIdx = i + 1;
    const scaleW = Math.max(1, Math.round(effectiveWidth * ov.width));
    const alpha = Math.max(0, Math.min(1, ov.opacity));
    const alphaExpr =
      alpha < 0.999
        ? `,format=rgba,colorchannelmixer=aa=${alpha.toFixed(3)}`
        : ',format=rgba';
    parts.push(`[${inputIdx}:v]scale=${scaleW}:-1${alphaExpr}[img${i}]`);
    // Center-anchored using main_w / main_h expressions so positioning
    // matches the DOM preview exactly.
    const x = `(main_w*${ov.positionX.toFixed(4)})-(overlay_w/2)`;
    const y = `(main_h*${ov.positionY.toFixed(4)})-(overlay_h/2)`;
    parts.push(`[v${i}][img${i}]overlay=${x}:${y}[v${i + 1}]`);
  });
  return parts.join(';');
}

// Fetch a Google Font for burning. Strategy:
//   1. /api/font proxy → static TTF from Fontsource / Google CSS scrape.
//      Works for most fonts and avoids woff2-in-wasm uncertainty.
//   2. Direct WOFF2 from Google CSS (browser fetch) — fallback for
//      variable-only fonts where /api/font can't find a static TTF.
//      The ffmpeg-wasm freetype build CAN load woff2 if it was built
//      with brotli support, and empirically this works for the core-mt
//      0.12.10 build (the original burn pipeline used this path
//      exclusively and users confirmed it worked).
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
  const progressHandler = ({ progress }: { progress: number }) => {
    lastProgressAt = Date.now();
    if (firstProgress) {
      console.debug('[burn] first progress event', { progress });
      firstProgress = false;
    }
    onProgress?.(Math.max(0, Math.min(1, progress)));
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

    // Generate the ASS file (no embedded [Fonts] — libass loads fonts from
    // the fontsdir directory below). The original burn pipeline that the
    // user remembers as "working" used this exact directory-based approach,
    // so we restore it. The modern features (multi-style, text overlays,
    // karaoke) still go through generateAss, just without inlined fonts.
    const assContent = generateAss({
      blocks: effectiveBlocks,
      style,
      videoWidth,
      videoHeight,
      textOverlays: effectiveTextOverlays,
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

    // Create the fonts directory and write every font we need into it.
    // libass scans this directory at filter init time and adds each readable
    // font to its in-memory pool — that's how it matches the family name in
    // the ASS Style line back to a real glyph table. The "can't find
    // selected font provider" stderr line is misleading: it refers to the
    // OS-level font lookup (fontconfig / coretext / directwrite), none of
    // which are compiled into the ffmpeg-wasm core. The directory scan
    // works regardless of those providers.
    try {
      await ff.createDir(fontsDir);
    } catch {
      // may already exist
    }

    // Custom user-uploaded fonts. We clone the bytes so the long-lived
    // ArrayBuffer in the editor store stays intact even after the worker
    // takes ownership of FS writes — without this, the next burn would
    // throw "Cannot perform Construct on a detached ArrayBuffer".
    let fontsWritten = 0;
    for (const f of customFonts) {
      if (isDetached(f.buffer)) {
        console.warn(
          `[burn] custom font "${f.name}" has a detached buffer — skipping. ` +
            `Reload the page to recover the original bytes from IndexedDB.`,
        );
        continue;
      }
      await ff.writeFile(
        `${fontsDir}/${f.name}.${f.format}`,
        cloneBytesForFFmpeg(f.buffer),
      );
      fontsWritten++;
    }

    // Google Font for the main subtitle style. Fetched as TTF (not woff2)
    // because the freetype baked into ffmpeg-wasm doesn't include brotli,
    // so woff2 silently fails to decode. /api/font handles the TTF lookup
    // (Fontsource → Google CSS scrape fallback).
    const mainFont = await fetchGoogleFontFile(
      style.fontFamily,
      style.fontWeight,
    );
    if (mainFont) {
      await ff.writeFile(
        `${fontsDir}/${mainFont.name}`,
        cloneBytesForFFmpeg(mainFont.buffer),
      );
      fontsWritten++;
    }
    // One file per unique family/weight used by text overlays. Same TTF
    // lookup path. We dedupe so we don't waste a roundtrip on the family
    // already covered by the main subtitle style.
    const seen = new Set<string>([`${style.fontFamily}@${style.fontWeight}`]);
    for (const t of textOverlays) {
      const key = `${t.fontFamily}@${t.fontWeight}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const f = await fetchGoogleFontFile(t.fontFamily, t.fontWeight);
      if (f) {
        await ff.writeFile(
          `${fontsDir}/${f.name}`,
          cloneBytesForFFmpeg(f.buffer),
        );
        fontsWritten++;
      }
    }
    console.debug('[burn] fonts written to fontsdir', { fontsWritten });
    if (fontsWritten === 0) {
      throw new Error(
        'No fonts could be loaded for burning. Check that the selected font ' +
          `("${style.fontFamily}") is available in our /api/font proxy or ` +
          'upload it as a custom font, then try again.',
      );
    }

    // Write each image overlay to the ffmpeg FS so we can reference it as
    // a separate input. We use `effectiveOverlays` here because cut-driven
    // remapping may have split a single overlay into multiple time
    // fragments — each fragment is its own ffmpeg input so the input
    // indices in buildOverlayComplex line up.
    for (let i = 0; i < effectiveOverlays.length; i++) {
      const ov = effectiveOverlays[i];
      const name = `overlay_${i}.${extForMime(ov.mime)}`;
      await ff.writeFile(name, dataUrlToBytes(ov.dataUrl));
      overlayNames.push(name);
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
        filterParts.push(
          buildOverlayComplex(
            effectiveOverlays,
            subsFilter,
            effectiveWidth,
            vSource,
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
      for (const name of overlayNames) {
        args.push('-i', name);
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
