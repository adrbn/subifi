// Curated remote fonts that aren't on Google Fonts but we want first-class.
// Each family declares its available weight/italic variants and a URL
// resolver so the picker can inject @font-face rules on demand.
//
// Marianne is the official French government typeface (Etalab Open
// License). The full family — Thin (100), Light (300), Regular (400),
// Medium (500), Bold (700), ExtraBold (800) and their italics — is
// pre-converted from WOFF2 (DRANE Lyon's GitLab forge) to OTF at build
// time by `scripts/convert-marianne.mjs` and stored under
// `/public/fonts/curated/marianne/`. Serving them as static assets has
// three big advantages over fetching+decompressing on the fly:
//   - No runtime dependency on `wawoff2` (which has trouble bundling
//     on Vercel because of its inline-base64 wasm).
//   - Zero CPU cost on every request — the OTF is just a static file.
//   - Works offline (e.g. local dev with no network).

export type FontVariant = {
  weight: number;
  italic: boolean;
  label: string;         // "Regular", "Bold Italic", etc. — shown in the picker
};

export type CuratedFont = {
  family: string;        // CSS font-family name we register via @font-face
  displayName: string;   // what the picker shows
  variants: FontVariant[];
  // Resolve the URL for a given variant. Returns null when the variant
  // isn't available. The URL is resolved relative to the site origin
  // (e.g. `/fonts/...` for a static asset under /public).
  urlFor: (v: FontVariant) => string | null;
};

// Static assets under `/public/fonts/curated/marianne/`. The conversion
// from upstream WOFF2 happens at build time via
// `scripts/convert-marianne.mjs`. Re-run that script when bumping the
// upstream version.
const MARIANNE_STATIC = '/fonts/curated/marianne';

function marianneWeightName(weight: number): string | null {
  switch (weight) {
    case 100: return 'Thin';
    case 300: return 'Light';
    case 400: return 'Regular';
    case 500: return 'Medium';
    case 700: return 'Bold';
    case 800: return 'ExtraBold';
    default:  return null;
  }
}

function marianneStaticPath(v: FontVariant): string | null {
  const w = marianneWeightName(v.weight);
  if (!w) return null;
  const italic = v.italic ? '_Italic' : '';
  return `${MARIANNE_STATIC}/Marianne-${w}${italic}.otf`;
}

export const CURATED_FONTS: CuratedFont[] = [
  {
    family: 'Marianne',
    displayName: 'Marianne',
    // All 12 variants of the Marianne typeface — pre-bundled in
    // /public so they ship on every deploy with no runtime fetching.
    variants: [
      { weight: 100, italic: false, label: 'Thin' },
      { weight: 100, italic: true,  label: 'Thin Italic' },
      { weight: 300, italic: false, label: 'Light' },
      { weight: 300, italic: true,  label: 'Light Italic' },
      { weight: 400, italic: false, label: 'Regular' },
      { weight: 400, italic: true,  label: 'Regular Italic' },
      { weight: 500, italic: false, label: 'Medium' },
      { weight: 500, italic: true,  label: 'Medium Italic' },
      { weight: 700, italic: false, label: 'Bold' },
      { weight: 700, italic: true,  label: 'Bold Italic' },
      { weight: 800, italic: false, label: 'ExtraBold' },
      { weight: 800, italic: true,  label: 'ExtraBold Italic' },
    ],
    urlFor: (v) => marianneStaticPath(v),
  },
];

export function findCuratedFont(family: string): CuratedFont | null {
  return CURATED_FONTS.find((f) => f.family === family) ?? null;
}

// Inject an @font-face rule for a given curated-font variant. Idempotent per
// (family, weight, italic) triple — calling twice with the same variant is a
// no-op.
//
// `src` points at the same-origin static asset under /public so the
// browser doesn't have to deal with cross-origin font CORS, and the
// burn pipeline and the preview load the EXACT same bytes.
export function loadCuratedFontVariant(font: CuratedFont, variant: FontVariant): void {
  if (typeof document === 'undefined') return;
  const id = `cf-remote-${font.family}-${variant.weight}-${variant.italic ? 'i' : 'n'}`;
  if (document.getElementById(id)) return;
  const url = font.urlFor(variant);
  if (!url) return;
  const el = document.createElement('style');
  el.id = id;
  el.textContent =
    `@font-face {` +
    ` font-family: "${font.family}";` +
    ` font-weight: ${variant.weight};` +
    ` font-style: ${variant.italic ? 'italic' : 'normal'};` +
    ` src: url("${url}") format("opentype");` +
    ` font-display: swap;` +
    ` }`;
  document.head.appendChild(el);
}

// Load all variants for a curated font up-front. Useful when the user picks
// the family — we don't know which weight/italic they'll want next, so we
// preload everything. woff2 files are small (~25-50KB each).
export function loadCuratedFontFamily(family: string): void {
  const f = findCuratedFont(family);
  if (!f) return;
  for (const v of f.variants) loadCuratedFontVariant(f, v);
}

// Does the requested (family, weight, italic) actually resolve to a CDN
// file? When the answer is `false` the burn pipeline cannot fetch a TTF
// for it AND the browser CSS @font-face will silently fall back to a
// system font in the preview. We use this to surface a pre-export
// warning instead of letting the user wait 2 minutes for an MP4 with no
// burned subtitles.
export function curatedVariantExists(
  family: string,
  weight: number,
  italic: boolean,
): boolean {
  const font = findCuratedFont(family);
  if (!font) return false;
  // First check the declared variant list — fast path, no string ops.
  const declared = font.variants.find(
    (v) => v.weight === weight && v.italic === italic,
  );
  if (declared) return font.urlFor(declared) !== null;
  // The variant isn't even declared (e.g. legacy state with weight 800).
  return false;
}

// Find the best-matching variant for a (weight, italic) pair. Used when the
// user nudges the weight slider — we snap to the nearest declared variant.
export function nearestVariant(
  font: CuratedFont,
  weight: number,
  italic: boolean,
): FontVariant {
  const candidates = font.variants.filter((v) => v.italic === italic);
  const pool = candidates.length > 0 ? candidates : font.variants;
  let best = pool[0];
  let bestDist = Math.abs(best.weight - weight);
  for (const v of pool.slice(1)) {
    const d = Math.abs(v.weight - weight);
    if (d < bestDist) {
      best = v;
      bestDist = d;
    }
  }
  return best;
}
