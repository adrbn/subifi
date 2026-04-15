import type { Style, SubtitleBlock, TextOverlay } from './types';

// Generates an ASS (Advanced SubStation Alpha) file from the project state.
// The file is consumed by ffmpeg's `subtitles` filter (libass) during burn-in.
//
// Rounded backgrounds: When a style has backgroundRadius > 0 we emit TWO
// Dialogue lines per subtitle — a background layer drawn via \p1 drawing
// mode (rounded rectangle shape), and a text layer with outline only. The
// text dimensions must be measured by the caller (see burn-in.ts
// measureBlockText()) and passed via `blockMetrics`.

// --- Export visual compensation ---
// The preview (CSS + CoreText on macOS) renders text noticeably larger than
// libass (FreeType). Two effects compound:
//   1. Font engines differ: CoreText maps font-size → glyph outlines with
//      different metric table interpretation than FreeType, producing ~15-20%
//      more visual weight.
//   2. CSS 8-directional text-shadow outlines add perceived size that libass
//      vector strokes don't match (~10-15% extra).
// Combined, preview text appears ~30-40% larger than export at the same
// nominal font size. FONT_SIZE_BOOST compensates.
const FONT_SIZE_BOOST = 1.7;    // matches CSS/CoreText rendering weight
const RADIUS_BOOST = 1.4;       // 40% more radius to match small-scale perception
// Background box scale partially tracks FONT_SIZE_BOOST. Metrics come from
// Canvas measureText at the NOMINAL fontSize, but libass paints text at
// fontSize × FONT_SIZE_BOOST. However, libass (FreeType) renders narrower
// than Canvas (CoreText) at the same nominal size, so scaling by the full
// FONT_SIZE_BOOST (1.7) overshoots and gives visibly oversized boxes; leaving
// it at 1.0 undershoots. 1.35 is the empirical sweet spot.
const BOX_SCALE = 1.2;
// Vertical correction applied to the rounded background box (NOT the text).
// libass anchors centered text on the em-box midline, which sits BELOW the
// visual ink midline in screen coordinates (ascenders extend higher than
// descenders, so the optical center of caps is above the metric center).
// Sliding the box up by a fraction of the boosted font size makes the box
// wrap the visible ink instead of the metric envelope — without touching
// any text \pos, so different-sized texts can't drift toward each other.
const BOX_VERTICAL_NUDGE = 0.05;

function hexToAssColor(hex: string, alpha = 1): string {
  const h = hex.replace('#', '').padEnd(6, '0');
  const r = h.slice(0, 2).toUpperCase();
  const g = h.slice(2, 4).toUpperCase();
  const b = h.slice(4, 6).toUpperCase();
  // ASS uses TRANSPARENCY (00 = opaque, FF = fully transparent),
  // the inverse of what CSS calls alpha.
  const transparency = Math.round((1 - alpha) * 255)
    .toString(16)
    .padStart(2, '0')
    .toUpperCase();
  return `&H${transparency}${b}${g}${r}`;
}

function formatAssTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor((seconds - Math.floor(seconds)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\N')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}');
}

function alignmentNumber(textAlign: Style['textAlign']): number {
  // middle row in ASS numpad layout; vertical anchor == middle
  if (textAlign === 'left') return 4;
  if (textAlign === 'right') return 6;
  return 5;
}

// Build a single ASS `Style:` line. `mode` controls background rendering:
//   'auto'    – original behavior (BorderStyle=3 when has bg, else 1)
//   'bg-only' – BorderStyle=3 for the background box layer (text will be hidden)
//   'text-only' – BorderStyle=1 with text outline (no opaque box)
type StyleMode = 'auto' | 'bg-only' | 'text-only';

function buildStyleLine(name: string, s: Style, mode: StyleMode = 'auto'): string {
  const hasBg = s.backgroundOpacity > 0;

  let borderStyle: number;
  let outlineCol: string;
  let backCol: string;
  let outline: number;

  if (mode === 'text-only' || (!hasBg && mode === 'auto')) {
    // Text layer: outline around the text, no opaque box.
    borderStyle = 1;
    outlineCol = hexToAssColor(s.textOutlineColor, 1);
    backCol = hexToAssColor('#000000', 0);
    outline = s.textOutlineWidth;
  } else {
    // Background layer or auto-with-bg: opaque box.
    borderStyle = 3;
    outlineCol = hexToAssColor(s.backgroundColor, s.backgroundOpacity);
    backCol = hexToAssColor(s.backgroundColor, s.backgroundOpacity);
    outline = Math.max(s.backgroundPaddingX, s.backgroundPaddingY);
  }

  const primary = hexToAssColor(s.textColor, 1);
  const secondary = s.karaoke
    ? hexToAssColor(s.karaokeBaseColor, 1)
    : '&H000000FF';
  const bold = s.fontWeight >= 600 ? -1 : 0;
  const italic = s.italic ? -1 : 0;
  const align = alignmentNumber(s.textAlign);
  const spacing = s.letterSpacing ?? 0;
  const boostedFontSize = Math.round(s.fontSize * FONT_SIZE_BOOST);
  return `Style: ${name},${s.fontFamily},${boostedFontSize},${primary},${secondary},${outlineCol},${backCol},${bold},${italic},0,0,100,100,${spacing},0,${borderStyle},${outline},0,${align},10,10,10,1`;
}

// Build the karaoke-tagged dialogue text for a block. Each word becomes
// `{\k<centiseconds>}<word>` so libass swaps SecondaryColour →
// PrimaryColour as each word's time elapses. Returns null when the block
// has no per-word timings (caller falls back to plain text).
function buildKaraokeText(block: SubtitleBlock): string | null {
  if (!block.words || block.words.length === 0) return null;
  let cursor = block.start;
  const parts: string[] = [];
  for (const w of block.words) {
    // Gap before this word (silence between words). Emit a 0-content \k
    // so the highlight timer keeps advancing without highlighting anything.
    const gap = Math.max(0, w.start - cursor);
    if (gap > 0) parts.push(`{\\k${Math.round(gap * 100)}}`);
    const dur = Math.max(1, Math.round((w.end - w.start) * 100));
    // Escape each word individually — \\N for newlines, \\{ \\} for braces.
    const safe = escapeAssText(w.text);
    parts.push(`{\\k${dur}}${safe} `);
    cursor = w.end;
  }
  return parts.join('').trimEnd();
}

// Measured text bounding box (in PlayRes script units) for a subtitle block.
// Computed by burn-in.ts measureBlockText() using Canvas 2D.
export type BlockMetrics = {
  width: number;  // text content width (no padding)
  height: number; // text content height (no padding)
};

// Build a rounded-rectangle ASS drawing path (for \p1 mode).
// Coordinates go from (0,0) to (w,h). With a DrawBG style that has
// FontSize=64 and Alignment=7, 1 drawing unit = 1 PlayRes pixel, and
// \pos(x1,y1) places the top-left corner.
function roundedRectDraw(w: number, h: number, r: number): string {
  const rx = Math.min(Math.round(r), Math.round(w / 2));
  const ry = Math.min(Math.round(r), Math.round(h / 2));
  const W = Math.round(w);
  const H = Math.round(h);
  // κ ≈ 0.5523 for a near-perfect circular arc via cubic bezier.
  const kx = Math.round(rx * 0.5523);
  const ky = Math.round(ry * 0.5523);

  return [
    `m ${rx} 0`,
    `l ${W - rx} 0`,
    `b ${W - rx + kx} 0 ${W} ${ry - ky} ${W} ${ry}`,
    `l ${W} ${H - ry}`,
    `b ${W} ${H - ry + ky} ${W - rx + kx} ${H} ${W - rx} ${H}`,
    `l ${rx} ${H}`,
    `b ${rx - kx} ${H} 0 ${H - ry + ky} 0 ${H - ry}`,
    `l 0 ${ry}`,
    `b 0 ${ry - ky} ${rx - kx} 0 ${rx} 0`,
  ].join(' ');
}

// Encode font bytes for the ASS [Fonts] section. ASS uses a custom encoding:
// every 3 bytes → 4 chars by splitting into 6-bit groups and adding 33.
// Lines are max 80 characters (20 triplets = 60 source bytes per line).
export type EmbeddedFont = { filename: string; data: Uint8Array };

function encodeAssFontData(data: Uint8Array): string[] {
  const lines: string[] = [];
  const BYTES_PER_LINE = 60; // 60 bytes → 80 encoded chars per line
  for (let off = 0; off < data.length; off += BYTES_PER_LINE) {
    const end = Math.min(off + BYTES_PER_LINE, data.length);
    let line = '';
    for (let i = off; i < end; i += 3) {
      const remaining = end - i;
      const b1 = data[i];
      const b2 = remaining > 1 ? data[i + 1] : 0;
      const b3 = remaining > 2 ? data[i + 2] : 0;
      // Always emit first 2 chars (covers 1+ bytes).
      line += String.fromCharCode(
        (b1 >> 2) + 33,
        (((b1 & 3) << 4) | (b2 >> 4)) + 33,
      );
      // 3rd char only if we had 2+ source bytes.
      if (remaining > 1) {
        line += String.fromCharCode((((b2 & 15) << 2) | (b3 >> 6)) + 33);
      }
      // 4th char only if we had a full 3-byte triplet.
      if (remaining > 2) {
        line += String.fromCharCode((b3 & 63) + 33);
      }
    }
    lines.push(line);
  }
  return lines;
}

export type AssGenInput = {
  blocks: SubtitleBlock[];
  style: Style;
  videoWidth: number;
  videoHeight: number;
  textOverlays?: TextOverlay[];
  // Map of script key → internal font family name for fallback fonts.
  // Currently: { cjk: "Noto Sans SC" }. Used to wrap non-Latin character
  // runs with {\fn<name>} overrides so libass picks the right font.
  fallbackFonts?: Record<string, string>;
  // Canvas-measured text dimensions per block index. When present AND the
  // block has backgroundRadius > 0, the generator emits a dual-layer
  // rendering (bg + text) with a \p1 drawn rounded-rect background.
  blockMetrics?: Map<number, BlockMetrics>;
  // Same as blockMetrics but for text overlays (keyed by overlay index).
  textOverlayMetrics?: Map<number, BlockMetrics>;
  // Fonts to embed directly in the ASS [Fonts] section. This is the most
  // reliable way to provide fonts to libass in ffmpeg-wasm — it bypasses
  // fontsdir scanning entirely.
  embeddedFonts?: EmbeddedFont[];
};

// CJK Unicode range — same regex as burn-in.ts detectNeededFallbacks().
const CJK_RE =
  /[\u2E80-\u9FFF\uF900-\uFAFF\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]+/g;

// Wrap runs of CJK characters in {\fn<fallbackFont>}...{\fn<primaryFont>}
// so libass switches to the CJK-capable font for those glyphs. Text that
// has already been escaped by escapeAssText() is safe to wrap — the
// override tags are injected AROUND character runs, not inside them.
function wrapCjkRuns(
  text: string,
  primaryFont: string,
  cjkFont: string,
): string {
  return text.replace(CJK_RE, (match) => {
    return `{\\fn${cjkFont}}${match}{\\fn${primaryFont}}`;
  });
}

export function generateAss({
  blocks,
  style,
  videoWidth,
  videoHeight,
  textOverlays = [],
  fallbackFonts = {},
  blockMetrics,
  textOverlayMetrics,
  embeddedFonts = [],
}: AssGenInput): string {
  // Decide per-block whether to use dual-layer (rounded bg) or single-layer.
  const useDualLayer = (s: Style, idx: number): boolean =>
    s.backgroundOpacity > 0 &&
    (s.backgroundRadius ?? 0) > 0 &&
    !!blockMetrics?.has(idx);

  // Per-block override styles. Block i with an override gets style "B{i}"
  // built by merging the override over the global style. Blocks without
  // overrides reference "Default".
  //
  // When dual-layer is active for a block, the text layer uses a text-only
  // style (BorderStyle=1) while the BG is drawn via \p1 with the "DrawBG"
  // style (a single shared style for all drawing-mode backgrounds).
  const blockStyleLines: string[] = [];

  blocks.forEach((b, i) => {
    const merged: Style = b.styleOverride
      ? { ...style, ...b.styleOverride }
      : style;
    const hasOverride = b.styleOverride && Object.keys(b.styleOverride).length > 0;
    const dual = useDualLayer(merged, i);

    if (dual && hasOverride) {
      // Dual-layer with override: per-block text-only style (BG drawn via \p1).
      blockStyleLines.push(buildStyleLine(`B${i}`, merged, 'text-only'));
    } else if (dual) {
      // Dual-layer without override: will use Default_TXT for text.
    } else if (hasOverride) {
      blockStyleLines.push(buildStyleLine(`B${i}`, merged, 'auto'));
    }
  });

  // Default_TXT: text-only variant of the Default style for dual-layer blocks
  // without per-block overrides.
  const globalHasRadius = (style.backgroundRadius ?? 0) > 0 && style.backgroundOpacity > 0;
  const needsDefaultTxt = globalHasRadius && blockMetrics != null &&
    blocks.some((b, i) =>
      (!b.styleOverride || Object.keys(b.styleOverride).length === 0) &&
      blockMetrics.has(i));
  const defaultTxtLine = needsDefaultTxt
    ? buildStyleLine('Default_TXT', style, 'text-only')
    : null;

  // DrawBG: shared style for all \p1 drawn backgrounds. FontSize=64 makes
  // 1 drawing unit = 1 PlayRes pixel. Alignment=7 (top-left) so \pos()
  // places the top-left corner of the drawn shape. MUST use the same font
  // as the main style — libass silently drops Dialogue lines whose style
  // references a font not found in fontsdir.
  const needsDrawBG = (blockMetrics != null && blockMetrics.size > 0) ||
    (textOverlayMetrics != null && textOverlayMetrics.size > 0);
  const drawBgLine = needsDrawBG
    ? `Style: DrawBG,${style.fontFamily},64,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`
    : null;

  // Each text overlay also gets its own style. We treat TextOverlay as a
  // Style-shaped record by mapping the (compatible) fields onto a Style.
  const overlayStyleLines = textOverlays.map((t, i) => {
    const asStyle: Style = {
      fontFamily: t.fontFamily,
      fontSize: t.fontSize,
      fontWeight: t.fontWeight,
      italic: t.italic,
      textColor: t.textColor,
      textOutlineColor: t.textOutlineColor,
      textOutlineWidth: t.textOutlineWidth,
      backgroundColor: t.backgroundColor,
      backgroundOpacity: t.backgroundOpacity,
      backgroundPaddingX: t.backgroundPaddingX,
      backgroundPaddingY: t.backgroundPaddingY,
      backgroundRadius: t.backgroundRadius,
      positionX: t.positionX,
      positionY: t.positionY,
      maxWidth: t.maxWidth,
      textAlign: t.textAlign,
      lineHeight: 1.2,
      letterSpacing: 0,
      wordSpacing: 0,
      karaoke: false,
      karaokeBaseColor: '#94a3b8',
    };
    const needsDual = t.backgroundOpacity > 0 &&
      (t.backgroundRadius ?? 0) > 0 &&
      !!textOverlayMetrics?.has(i);
    return buildStyleLine(`TO${i}`, asStyle, needsDual ? 'text-only' : 'auto');
  });

  const extraStyleLines: string[] = [];
  if (defaultTxtLine) extraStyleLines.push(defaultTxtLine);
  if (drawBgLine) extraStyleLines.push(drawBgLine);

  // Build [Fonts] section — embeds font binaries directly in the ASS file
  // using the SSA UU-like encoding (3 bytes → 4 chars, +33 offset). libass
  // extracts these to a temp dir at parse time, so fonts are always available
  // regardless of fontsdir scanning quirks.
  const fontsSection: string[] = [];
  if (embeddedFonts.length > 0) {
    fontsSection.push('[Fonts]');
    for (const font of embeddedFonts) {
      fontsSection.push(`fontname: ${font.filename}`);
      fontsSection.push(...encodeAssFontData(font.data));
      fontsSection.push('');
    }
  }

  const header = [
    '[Script Info]',
    'Title: SubIFI',
    'ScriptType: v4.00+',
    `PlayResX: ${videoWidth}`,
    `PlayResY: ${videoHeight}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    ...fontsSection,
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    buildStyleLine('Default', style),
    ...extraStyleLines,
    ...blockStyleLines,
    ...overlayStyleLines,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events: string[] = [];

  // Minimal 10ms gap (one ASS centisecond, the format's timestamp precision)
  // prevents consecutive cues from visually overlapping in libass when source
  // timings have slight overlap. The DOM preview doesn't show this because CSS
  // paints only the last active block on top, but libass renders every active
  // cue — including two rounded backgrounds stacked on the same line.
  const OVERLAP_GUARD_SEC = 0.01;

  blocks.forEach((b, i) => {
    const next = blocks[i + 1];
    const clippedEnd =
      next && b.end > next.start - OVERLAP_GUARD_SEC
        ? Math.max(b.start + 0.01, next.start - OVERLAP_GUARD_SEC)
        : b.end;
    const start = formatAssTimestamp(b.start);
    const end = formatAssTimestamp(clippedEnd);
    const merged: Style = b.styleOverride
      ? { ...style, ...b.styleOverride }
      : style;
    const hasOverride = b.styleOverride && Object.keys(b.styleOverride).length > 0;
    const dual = useDualLayer(merged, i);
    const posX = Math.round(merged.positionX * videoWidth);
    const posY = Math.round(merged.positionY * videoHeight);

    // Build text content (shared between single and dual-layer paths).
    const karaokeText = merged.karaoke ? buildKaraokeText(b) : null;
    let text = karaokeText ?? escapeAssText(b.text);
    const ws = merged.wordSpacing ?? 0;
    if (ws !== 0 && !karaokeText) {
      const ls = merged.letterSpacing ?? 0;
      text = text.replace(/ /g, `{\\fsp${ls + ws}} {\\fsp${ls}}`);
    }
    if (fallbackFonts.cjk) {
      text = wrapCjkRuns(text, merged.fontFamily, fallbackFonts.cjk);
    }

    if (dual) {
      // --- Dual-layer: \p1 drawn rounded background + text overlay ---
      const metrics = blockMetrics!.get(i)!;
      const padX = merged.backgroundPaddingX;
      const padY = merged.backgroundPaddingY;
      const radius = Math.round((merged.backgroundRadius ?? 0) * RADIUS_BOOST);
      const boostedFs = Math.round(merged.fontSize * FONT_SIZE_BOOST);
      // Box is sized from the canvas-measured text dims (padded). We do NOT
      // apply FONT_SIZE_BOOST here — see BOX_SCALE comment.
      const boxW = metrics.width * BOX_SCALE + padX * 2;
      const boxH = metrics.height * BOX_SCALE + padY * 2;
      const boxX = Math.round(posX - boxW / 2);
      // Slide the box up so it visually wraps the ink, not the metric box.
      // Text \pos stays at posY — only the background moves.
      const boxY = Math.round(posY - boxH / 2 - boostedFs * BOX_VERTICAL_NUDGE);
      const drawPath = roundedRectDraw(boxW, boxH, radius);

      // Background color in ASS BGR format.
      const bgHex = merged.backgroundColor.replace('#', '').padEnd(6, '0');
      const bgB = bgHex.slice(4, 6).toUpperCase();
      const bgG = bgHex.slice(2, 4).toUpperCase();
      const bgR = bgHex.slice(0, 2).toUpperCase();
      const bgAlpha = Math.round((1 - merged.backgroundOpacity) * 255)
        .toString(16).padStart(2, '0').toUpperCase();

      const txtStyleName = hasOverride ? `B${i}` : 'Default_TXT';

      // Layer 0: drawn rounded-rect background via \p1.
      const bgInline =
        `{\\pos(${boxX},${boxY})` +
        `\\1c&H${bgB}${bgG}${bgR}&` +
        `\\1a&H${bgAlpha}&` +
        `\\bord0\\shad0\\p1}`;
      events.push(`Dialogue: 0,${start},${end},DrawBG,,0,0,0,,${bgInline}${drawPath}`);

      // Layer 1: text with outline only. Boosted \fs for visual parity.
      const txtInline = `{\\pos(${posX},${posY})\\fs${boostedFs}}`;
      events.push(`Dialogue: 1,${start},${end},${txtStyleName},,0,0,0,,${txtInline}${text}`);
    } else {
      // --- Single-layer (no radius or no metrics) ---
      const styleName = hasOverride ? `B${i}` : 'Default';
      const hasBg = merged.backgroundOpacity > 0;
      const bordOverrides = hasBg
        ? `\\xbord${merged.backgroundPaddingX}\\ybord${merged.backgroundPaddingY}`
        : '';
      const boostedFs = Math.round(merged.fontSize * FONT_SIZE_BOOST);
      const inline = `{\\pos(${posX},${posY})\\fs${boostedFs}${bordOverrides}}`;
      events.push(`Dialogue: 0,${start},${end},${styleName},,0,0,0,,${inline}${text}`);
    }
  });

  // Text overlays are layer 2 so they sit on top of the subtitle layers.
  const overlayEvents: string[] = [];
  textOverlays.forEach((t, i) => {
    const start = formatAssTimestamp(t.start);
    const end = formatAssTimestamp(t.end);
    let text = escapeAssText(t.text);
    if (fallbackFonts.cjk) {
      text = wrapCjkRuns(text, t.fontFamily, fallbackFonts.cjk);
    }
    const tx = Math.round(t.positionX * videoWidth);
    const ty = Math.round(t.positionY * videoHeight);

    const needsDual = t.backgroundOpacity > 0 &&
      (t.backgroundRadius ?? 0) > 0 &&
      !!textOverlayMetrics?.has(i);

    if (needsDual) {
      const metrics = textOverlayMetrics!.get(i)!;
      const padX = t.backgroundPaddingX;
      const padY = t.backgroundPaddingY;
      const radius = Math.round((t.backgroundRadius ?? 0) * RADIUS_BOOST);
      const boostedFs = Math.round(t.fontSize * FONT_SIZE_BOOST);
      const boxW = metrics.width * BOX_SCALE + padX * 2;
      const boxH = metrics.height * BOX_SCALE + padY * 2;
      const boxX = Math.round(tx - boxW / 2);
      // Slide box up so it visually wraps the ink, not the metric box.
      const boxY = Math.round(ty - boxH / 2 - boostedFs * BOX_VERTICAL_NUDGE);
      const drawPath = roundedRectDraw(boxW, boxH, radius);

      const bgHex = t.backgroundColor.replace('#', '').padEnd(6, '0');
      const bgB = bgHex.slice(4, 6).toUpperCase();
      const bgG = bgHex.slice(2, 4).toUpperCase();
      const bgR = bgHex.slice(0, 2).toUpperCase();
      const bgAlpha = Math.round((1 - t.backgroundOpacity) * 255)
        .toString(16).padStart(2, '0').toUpperCase();

      const bgInline =
        `{\\pos(${boxX},${boxY})` +
        `\\1c&H${bgB}${bgG}${bgR}&` +
        `\\1a&H${bgAlpha}&` +
        `\\bord0\\shad0\\p1}`;
      overlayEvents.push(`Dialogue: 2,${start},${end},DrawBG,,0,0,0,,${bgInline}${drawPath}`);
      overlayEvents.push(`Dialogue: 3,${start},${end},TO${i},,0,0,0,,{\\pos(${tx},${ty})\\fs${boostedFs}}${text}`);
    } else {
      const hasBg = t.backgroundOpacity > 0;
      const bordOverrides = hasBg
        ? `\\xbord${t.backgroundPaddingX}\\ybord${t.backgroundPaddingY}`
        : '';
      const boostedFs = Math.round(t.fontSize * FONT_SIZE_BOOST);
      const inline = `{\\pos(${tx},${ty})\\fs${boostedFs}${bordOverrides}}`;
      overlayEvents.push(`Dialogue: 2,${start},${end},TO${i},,0,0,0,,${inline}${text}`);
    }
  });

  return [...header, ...events, ...overlayEvents, ''].join('\n');
}
