import { fetchFile } from '@ffmpeg/util';
import { getFFmpeg } from './ffmpeg-client';
import { generateAss } from './ass-generator';
import type {
  CustomFont,
  ImageOverlay,
  Style,
  SubtitleBlock,
} from './types';

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
};

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
): string {
  const parts: string[] = [`[0:v]${subsFilter}[v0]`];
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

const GOOGLE_FONT_CSS = (family: string, weight: number) =>
  `https://fonts.googleapis.com/css2?family=${encodeURIComponent(
    family,
  )}:wght@${weight}&display=swap`;

async function fetchGoogleFontFile(
  family: string,
  weight: number,
): Promise<{ name: string; buffer: ArrayBuffer } | null> {
  try {
    // mode: 'cors' is the default but made explicit here: under COEP
    // require-corp the response must come back with CORP or CORS headers,
    // and Google Fonts serves CORS.
    const cssRes = await fetch(GOOGLE_FONT_CSS(family, weight), { mode: 'cors' });
    if (!cssRes.ok) return null;
    const css = await cssRes.text();
    // Google returns woff2 by default. We need to extract the URL of the
    // actual font file for fallback. We prefer latin subset.
    const match = css.match(/url\((https:[^)]+\.woff2)\)/);
    if (!match) return null;
    const fontRes = await fetch(match[1], { mode: 'cors' });
    if (!fontRes.ok) return null;
    const buffer = await fontRes.arrayBuffer();
    return { name: `${family}.woff2`, buffer };
  } catch {
    return null;
  }
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
  } = input;
  const ff = await getFFmpeg();
  if (onProgress) {
    ff.on('progress', ({ progress }) => onProgress(Math.max(0, Math.min(1, progress))));
  }

  const inputName = 'in.mp4';
  const subsName = 'subs.ass';
  const outputName = 'out.mp4';
  const fontsDir = 'fonts';

  // Write input video and subtitle file.
  await ff.writeFile(inputName, await fetchFile(videoFile));
  const assContent = generateAss({ blocks, style, videoWidth, videoHeight });
  await ff.writeFile(subsName, new TextEncoder().encode(assContent));

  // Create fonts dir and write any custom fonts.
  try {
    await ff.createDir(fontsDir);
  } catch {
    // may already exist
  }
  for (const f of customFonts) {
    await ff.writeFile(`${fontsDir}/${f.name}.${f.format}`, new Uint8Array(f.buffer));
  }

  // Try to fetch the requested Google Font (best effort — libass will fall
  // back to the nearest available font if missing).
  const maybeFont = await fetchGoogleFontFile(style.fontFamily, style.fontWeight);
  if (maybeFont) {
    await ff.writeFile(`${fontsDir}/${maybeFont.name}`, new Uint8Array(maybeFont.buffer));
  }

  // Write each image overlay to the ffmpeg FS so we can reference it as a
  // separate input. Track the names so we can clean up afterwards.
  const overlayNames: string[] = [];
  for (let i = 0; i < overlays.length; i++) {
    const ov = overlays[i];
    const name = `overlay_${i}.${extForMime(ov.mime)}`;
    await ff.writeFile(name, dataUrlToBytes(ov.dataUrl));
    overlayNames.push(name);
  }

  // Auto-cap export resolution to 1080p on the short side. This is the single
  // biggest speed win for phone footage shot at 4K: ffmpeg.wasm (single
  // threaded) spends most of its time in x264, which is quadratic in pixel
  // count. 4K → 1080p is ~4x fewer pixels, so the burn is ~4x faster at
  // essentially no visible quality loss for social export. 1080p and below
  // pass through unchanged. Downscaled dimensions are forced to even so
  // libx264's YUV420 sampling is happy.
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

  if (overlays.length > 0) {
    const complex = buildOverlayComplex(overlays, subsFilter, effectiveWidth);
    const finalLabel = `[v${overlays.length}]`;
    const args: string[] = ['-i', inputName];
    for (const name of overlayNames) {
      args.push('-i', name);
    }
    args.push(
      '-filter_complex',
      complex,
      '-map',
      finalLabel,
      '-map',
      '0:a?',
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
    await ff.exec(args);
  } else {
    await ff.exec([
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
    ]);
  }

  const data = await ff.readFile(outputName);
  try {
    await ff.deleteFile(inputName);
    await ff.deleteFile(subsName);
    await ff.deleteFile(outputName);
    for (const name of overlayNames) {
      await ff.deleteFile(name);
    }
  } catch {
    // ignore
  }
  return data as Uint8Array;
}
