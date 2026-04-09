import type { Style, SubtitleBlock } from './types';

// Generates an ASS (Advanced SubStation Alpha) file from the project state.
// The file is consumed by ffmpeg's `subtitles` filter (libass) during burn-in.
//
// Note on fidelity: libass does NOT support rounded rectangle backgrounds
// natively. When backgroundOpacity > 0 we use BorderStyle=3 (opaque box)
// which has sharp corners. The DOM preview DOES show rounded corners; this
// is a documented preview/export divergence for the MVP.

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

export type AssGenInput = {
  blocks: SubtitleBlock[];
  style: Style;
  videoWidth: number;
  videoHeight: number;
};

export function generateAss({
  blocks,
  style,
  videoWidth,
  videoHeight,
}: AssGenInput): string {
  const hasBg = style.backgroundOpacity > 0;
  const primaryColour = hexToAssColor(style.textColor, 1);
  const outlineColour = hasBg
    ? hexToAssColor(style.backgroundColor, style.backgroundOpacity)
    : hexToAssColor(style.textOutlineColor, 1);
  const backColour = hasBg
    ? hexToAssColor(style.backgroundColor, style.backgroundOpacity)
    : hexToAssColor('#000000', 0);
  const borderStyle = hasBg ? 3 : 1;
  const outline = hasBg
    ? Math.max(style.backgroundPaddingX, style.backgroundPaddingY)
    : style.textOutlineWidth;
  const shadow = 0;
  const alignment = alignmentNumber(style.textAlign);
  const bold = style.fontWeight >= 600 ? -1 : 0;
  const italic = style.italic ? -1 : 0;
  // ASS fontname — if it's a Google Font or uploaded font, the family name
  // is what libass looks up in the fontsdir.
  const fontname = style.fontFamily;

  const header = [
    '[Script Info]',
    'Title: Sub-Easy-Ifi',
    'ScriptType: v4.00+',
    `PlayResX: ${videoWidth}`,
    `PlayResY: ${videoHeight}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${fontname},${style.fontSize},${primaryColour},&H000000FF,${outlineColour},${backColour},${bold},${italic},0,0,100,100,0,0,${borderStyle},${outline},${shadow},${alignment},10,10,10,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const posX = Math.round(style.positionX * videoWidth);
  const posY = Math.round(style.positionY * videoHeight);

  const events = blocks.map((b) => {
    const start = formatAssTimestamp(b.start);
    const end = formatAssTimestamp(b.end);
    const text = escapeAssText(b.text);
    // {\pos(x,y)} positions the anchor point of the textbox absolutely.
    // Anchor depends on the Alignment set in the Default style (4/5/6 →
    // middle-left/center/right). This lets positionX/Y drive where the
    // subtitle lands regardless of the video resolution.
    const inline = `{\\pos(${posX},${posY})}`;
    return `Dialogue: 0,${start},${end},Default,,0,0,0,,${inline}${text}`;
  });

  return [...header, ...events, ''].join('\n');
}
