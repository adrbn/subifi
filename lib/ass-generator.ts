import type { Style, SubtitleBlock, TextOverlay } from './types';

// Generates an ASS (Advanced SubStation Alpha) file from the project state.
// The file is consumed by ffmpeg's `subtitles` filter (libass) during burn-in.
//
// Rounded backgrounds: When a style has backgroundRadius > 0 we emit TWO
// Dialogue lines per subtitle — a background layer with an opaque box clipped
// to a rounded-rect vector path, and a text layer with outline only. The
// text dimensions must be measured by the caller (see burn-in.ts
// measureBlockText()) and passed via `blockMetrics`.
//
// Fonts: We use a belt-and-suspenders approach. The burn pipeline writes TTFs
// to a `fontsdir/` that ffmpeg's subtitles filter scans, AND we embed the
// same fonts in the ASS [Fonts] section. The [Fonts] section is the most
// reliable path in ffmpeg-wasm because libass extracts them to a temp dir it
// always trusts, whereas fontsdir scanning can silently fail in some builds.

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
  return `Style: ${name},${s.fontFamily},${s.fontSize},${primary},${secondary},${outlineCol},${backCol},${bold},${italic},0,0,100,100,${spacing},0,${borderStyle},${outline},0,${align},10,10,10,1`;
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

// Build a rounded-rectangle vector-clip string for ASS \clip(drawing).
// Coordinates are in PlayRes units (absolute). The path uses cubic bezier
// curves at each corner to approximate a CSS border-radius.
function roundedRectClip(
  cx: number,  // center X
  cy: number,  // center Y
  halfW: number,
  halfH: number,
  r: number,
): string {
  // Clamp radius so it doesn't exceed the half-dimensions.
  const rx = Math.min(r, halfW);
  const ry = Math.min(r, halfH);
  const x1 = Math.round(cx - halfW);
  const y1 = Math.round(cy - halfH);
  const x2 = Math.round(cx + halfW);
  const y2 = Math.round(cy + halfH);
  const rrx = Math.round(rx);
  const rry = Math.round(ry);
  // Cubic bezier control-point factor for quarter-circle approximation.
  // κ ≈ 0.5523 for a near-perfect circular arc.
  const kx = Math.round(rx * 0.5523);
  const ky = Math.round(ry * 0.5523);

  // Path: start at top-left + radius, go clockwise.
  return [
    `m ${x1 + rrx} ${y1}`,                       // move: top edge, right of TL corner
    `l ${x2 - rrx} ${y1}`,                        // line: top edge → before TR corner
    `b ${x2 - rrx + kx} ${y1} ${x2} ${y1 + rry - ky} ${x2} ${y1 + rry}`, // curve: TR corner
    `l ${x2} ${y2 - rry}`,                        // line: right edge → before BR corner
    `b ${x2} ${y2 - rry + ky} ${x2 - rrx + kx} ${y2} ${x2 - rrx} ${y2}`, // curve: BR corner
    `l ${x1 + rrx} ${y2}`,                        // line: bottom edge → before BL corner
    `b ${x1 + rrx - kx} ${y2} ${x1} ${y2 - rry + ky} ${x1} ${y2 - rry}`, // curve: BL corner
    `l ${x1} ${y1 + rry}`,                        // line: left edge → before TL corner
    `b ${x1} ${y1 + rry - ky} ${x1 + rrx - kx} ${y1} ${x1 + rrx} ${y1}`, // curve: TL corner
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
  // rendering (bg + text) with a rounded-rect \clip on the background.
  blockMetrics?: Map<number, BlockMetrics>;
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
  // When dual-layer is active for a block, we also generate a "B{i}_BG"
  // style (opaque box, no text outline) alongside the "B{i}" text style.
  const blockStyleLines: string[] = [];
  const defaultNeedsDual = useDualLayer(style, -1); // not used per-block, but we check global below

  blocks.forEach((b, i) => {
    const merged: Style = b.styleOverride
      ? { ...style, ...b.styleOverride }
      : style;
    const hasOverride = b.styleOverride && Object.keys(b.styleOverride).length > 0;
    const dual = useDualLayer(merged, i);

    if (dual && hasOverride) {
      // Dual-layer with override: per-block BG + text styles.
      blockStyleLines.push(buildStyleLine(`B${i}_BG`, merged, 'bg-only'));
      blockStyleLines.push(buildStyleLine(`B${i}`, merged, 'text-only'));
    } else if (hasOverride) {
      blockStyleLines.push(buildStyleLine(`B${i}`, merged, 'auto'));
    }
    // Blocks without overrides use Default_BG/Default_TXT (dual) or Default (single).
  });

  // Also generate dual-layer variants of the Default style if the global
  // style itself has a background radius and we have metrics for blocks that
  // use Default.
  const globalHasRadius = (style.backgroundRadius ?? 0) > 0 && style.backgroundOpacity > 0;
  const needsDefaultDual = globalHasRadius && blockMetrics != null &&
    blocks.some((b, i) =>
      (!b.styleOverride || Object.keys(b.styleOverride).length === 0) &&
      blockMetrics.has(i));
  const defaultBgLine = needsDefaultDual
    ? buildStyleLine('Default_BG', style, 'bg-only')
    : null;
  const defaultTxtLine = needsDefaultDual
    ? buildStyleLine('Default_TXT', style, 'text-only')
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
    return buildStyleLine(`TO${i}`, asStyle);
  });

  const extraStyleLines: string[] = [];
  if (defaultBgLine) extraStyleLines.push(defaultBgLine);
  if (defaultTxtLine) extraStyleLines.push(defaultTxtLine);

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

  blocks.forEach((b, i) => {
    const start = formatAssTimestamp(b.start);
    const end = formatAssTimestamp(b.end);
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
      // --- Dual-layer: rounded background ---
      const metrics = blockMetrics!.get(i)!;
      const padX = merged.backgroundPaddingX;
      const padY = merged.backgroundPaddingY;
      const radius = merged.backgroundRadius ?? 0;
      const halfW = metrics.width / 2 + padX;
      const halfH = metrics.height / 2 + padY;
      const clip = roundedRectClip(posX, posY, halfW, halfH, radius);

      // BG style name: either B{i}_BG or Default_BG depending on override
      const bgStyleName = hasOverride ? `B${i}_BG` : 'Default_BG';
      const txtStyleName = hasOverride ? `B${i}` : 'Default_TXT';

      // Layer 0: background box (text invisible, clipped to rounded rect).
      const bgInline =
        `{\\pos(${posX},${posY})` +
        `\\xbord${padX}\\ybord${padY}` +
        `\\1a&HFF&\\2a&HFF&` +        // hide text, keep box
        `\\clip(1,${clip})}`;
      events.push(`Dialogue: 0,${start},${end},${bgStyleName},,0,0,0,,${bgInline}${text}`);

      // Layer 1: text with outline only (no background box).
      const txtInline = `{\\pos(${posX},${posY})}`;
      events.push(`Dialogue: 1,${start},${end},${txtStyleName},,0,0,0,,${txtInline}${text}`);
    } else {
      // --- Single-layer (no radius or no metrics) ---
      const styleName = hasOverride ? `B${i}` : 'Default';
      const hasBg = merged.backgroundOpacity > 0;
      const bordOverrides = hasBg
        ? `\\xbord${merged.backgroundPaddingX}\\ybord${merged.backgroundPaddingY}`
        : '';
      const inline = `{\\pos(${posX},${posY})${bordOverrides}}`;
      events.push(`Dialogue: 0,${start},${end},${styleName},,0,0,0,,${inline}${text}`);
    }
  });

  // Text overlays are layer 2 so they sit on top of the subtitle layers.
  const overlayEvents = textOverlays.map((t, i) => {
    const start = formatAssTimestamp(t.start);
    const end = formatAssTimestamp(t.end);
    let text = escapeAssText(t.text);
    if (fallbackFonts.cjk) {
      text = wrapCjkRuns(text, t.fontFamily, fallbackFonts.cjk);
    }
    const tx = Math.round(t.positionX * videoWidth);
    const ty = Math.round(t.positionY * videoHeight);
    const hasBg = t.backgroundOpacity > 0;
    const bordOverrides = hasBg
      ? `\\xbord${t.backgroundPaddingX}\\ybord${t.backgroundPaddingY}`
      : '';
    const inline = `{\\pos(${tx},${ty})${bordOverrides}}`;
    return `Dialogue: 2,${start},${end},TO${i},,0,0,0,,${inline}${text}`;
  });

  return [...header, ...events, ...overlayEvents, ''].join('\n');
}
