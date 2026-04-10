import type { Style, SubtitleBlock, TextOverlay } from './types';

// Generates an ASS (Advanced SubStation Alpha) file from the project state.
// The file is consumed by ffmpeg's `subtitles` filter (libass) during burn-in.
//
// Note on fidelity: libass does NOT support rounded rectangle backgrounds
// natively. When backgroundOpacity > 0 we use BorderStyle=3 (opaque box)
// which has sharp corners. The DOM preview DOES show rounded corners; this
// is a documented preview/export divergence for the MVP.
//
// Note on fonts: ffmpeg-wasm's libass build has no fontconfig but DOES scan
// any directory passed via the subtitles filter's `fontsdir=` option. The
// burn-in pipeline (lib/burn-in.ts) writes every needed TTF into that
// directory before invoking ffmpeg, so the ASS file itself only needs to
// reference fonts by family name — no [Fonts] section / UU-encoded body.

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

// Build a single ASS `Style:` line. Used for both the default subtitle
// style and any per-block overrides — keeping this in one place avoids
// drift between the two paths.
function buildStyleLine(name: string, s: Style): string {
  const hasBg = s.backgroundOpacity > 0;
  const primary = hexToAssColor(s.textColor, 1);
  // SecondaryColour drives the unspoken-word color in libass karaoke
  // (\k tags). When karaoke is off it doesn't render so we can put any
  // value, but we still emit the karaoke base color in case the user
  // toggles karaoke on a per-block override.
  const secondary = s.karaoke
    ? hexToAssColor(s.karaokeBaseColor, 1)
    : '&H000000FF';
  const outlineCol = hasBg
    ? hexToAssColor(s.backgroundColor, s.backgroundOpacity)
    : hexToAssColor(s.textOutlineColor, 1);
  const backCol = hasBg
    ? hexToAssColor(s.backgroundColor, s.backgroundOpacity)
    : hexToAssColor('#000000', 0);
  const borderStyle = hasBg ? 3 : 1;
  const outline = hasBg
    ? Math.max(s.backgroundPaddingX, s.backgroundPaddingY)
    : s.textOutlineWidth;
  const bold = s.fontWeight >= 600 ? -1 : 0;
  const italic = s.italic ? -1 : 0;
  const align = alignmentNumber(s.textAlign);
  // ASS Spacing is in pixels (per-pair extra space). Default to 0 for
  // older snapshots that pre-date letterSpacing on Style.
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
}: AssGenInput): string {
  // Per-block override styles. Block i with an override gets style "B{i}"
  // built by merging the override over the global style. Blocks without
  // overrides reference "Default".
  const blockStyleLines = blocks
    .map((b, i) => {
      if (!b.styleOverride || Object.keys(b.styleOverride).length === 0) {
        return null;
      }
      const merged: Style = { ...style, ...b.styleOverride };
      return buildStyleLine(`B${i}`, merged);
    })
    .filter((line): line is string => line !== null);

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
      // TextOverlay doesn't yet expose line height / letter spacing, so
      // we keep them at the global Style defaults. Adding them on the
      // overlay would mean threading two more sliders into the StylePanel
      // for every overlay row — out of scope for this iteration.
      lineHeight: 1.2,
      letterSpacing: 0,
      wordSpacing: 0,
      // Text overlays don't currently expose karaoke (no per-word
      // timings on free-form text), so we hard-code them off here.
      karaoke: false,
      karaokeBaseColor: '#94a3b8',
    };
    return buildStyleLine(`TO${i}`, asStyle);
  });

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
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    buildStyleLine('Default', style),
    ...blockStyleLines,
    ...overlayStyleLines,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events = blocks.map((b, i) => {
    const start = formatAssTimestamp(b.start);
    const end = formatAssTimestamp(b.end);
    // Resolve which Style entry this block uses. Per-block overrides also
    // need their own positionX/Y because that lives on Style too.
    const merged: Style = b.styleOverride
      ? { ...style, ...b.styleOverride }
      : style;
    const styleName =
      b.styleOverride && Object.keys(b.styleOverride).length > 0
        ? `B${i}`
        : 'Default';
    const posX = Math.round(merged.positionX * videoWidth);
    const posY = Math.round(merged.positionY * videoHeight);
    const inline = `{\\pos(${posX},${posY})}`;
    // Pick karaoke text only when both the merged style asks for it AND
    // the block actually has word-level timings to drive the highlight.
    const karaokeText = merged.karaoke ? buildKaraokeText(b) : null;
    let text = karaokeText ?? escapeAssText(b.text);
    // Emulate word spacing in ASS: temporarily bump letter spacing for
    // each space character via inline \fsp overrides.
    const ws = merged.wordSpacing ?? 0;
    if (ws !== 0 && !karaokeText) {
      const ls = merged.letterSpacing ?? 0;
      text = text.replace(/ /g, `{\\fsp${ls + ws}} {\\fsp${ls}}`);
    }
    // Wrap CJK character runs with the fallback font so libass renders
    // them with Noto Sans SC (or similar) instead of showing rectangles.
    if (fallbackFonts.cjk) {
      text = wrapCjkRuns(text, merged.fontFamily, fallbackFonts.cjk);
    }
    return `Dialogue: 0,${start},${end},${styleName},,0,0,0,,${inline}${text}`;
  });

  // Text overlays are layer 1 so they sit on top of the subtitle layer if
  // they ever overlap visually.
  const overlayEvents = textOverlays.map((t, i) => {
    const start = formatAssTimestamp(t.start);
    const end = formatAssTimestamp(t.end);
    let text = escapeAssText(t.text);
    if (fallbackFonts.cjk) {
      text = wrapCjkRuns(text, t.fontFamily, fallbackFonts.cjk);
    }
    const tx = Math.round(t.positionX * videoWidth);
    const ty = Math.round(t.positionY * videoHeight);
    const inline = `{\\pos(${tx},${ty})}`;
    return `Dialogue: 1,${start},${end},TO${i},,0,0,0,,${inline}${text}`;
  });

  return [...header, ...events, ...overlayEvents, ''].join('\n');
}
