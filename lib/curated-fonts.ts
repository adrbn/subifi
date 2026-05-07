// Curated remote fonts that aren't on Google Fonts but we want first-class.
// Each family declares its available weight/italic variants and a URL
// resolver so the picker can inject @font-face rules on demand.
//
// Marianne is the official French government typeface (Etalab Open
// License). The full family — Thin (100), Light (300), Regular (400),
// Medium (500), Bold (700), ExtraBold (800) and their italics — is
// hosted on forge.apps.education.fr by the DRANE Lyon, who maintain a
// clean GitLab repo of all weights. The official @gouvfr/dsfr package
// on npm only ships 300/400/500/700, so we use it as a secondary
// fallback only when the primary source is unreachable.

export type FontVariant = {
  weight: number;
  italic: boolean;
  label: string;         // "Regular", "Bold Italic", etc. — shown in the picker
};

export type CuratedFont = {
  family: string;        // CSS font-family name we register via @font-face
  displayName: string;   // what the picker shows
  variants: FontVariant[];
  // Resolve the CDN URL for a given variant. Returning null means "not
  // available from this source".
  urlFor: (v: FontVariant) => string | null;
  // Optional secondary CDN. /api/font tries the primary URL first; on
  // network failure it falls back here. Returning null means "this
  // variant isn't on the secondary either", which short-circuits the
  // fallback (avoids a wasted round-trip).
  fallbackUrlFor?: (v: FontVariant) => string | null;
};

// Apps Education (DRANE Lyon) hosts the full Marianne family on a public
// GitLab forge. They keep all 12 variants (6 weights × 2 italics) which
// the DSFR npm package omits.
const APPS_EDU_MARIANNE =
  'https://forge.apps.education.fr/drane-lyon/fonts/-/raw/main';

// Secondary fallback — DSFR npm package via jsDelivr. Only ships 4 of
// the 6 weights but is on a more reputable CDN, so we try it second
// when the primary source is unreachable for one of those 4 weights.
const DSFR_VERSION = '1.13.0';
const DSFR_FONTS = `https://cdn.jsdelivr.net/npm/@gouvfr/dsfr@${DSFR_VERSION}/dist/fonts`;

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

// DSFR npm package — only Light, Regular, Medium, Bold are published.
// Returns null for the other weights so the caller can move on to the
// primary (Apps Education) source.
function marianneDsfrFilename(v: FontVariant): string | null {
  if (![300, 400, 500, 700].includes(v.weight)) return null;
  const w = marianneWeightName(v.weight);
  if (!w) return null;
  const italic = v.italic ? '_Italic' : '';
  return `Marianne-${w}${italic}.woff2`;
}

function marianneAppsEduFilename(v: FontVariant): string | null {
  const w = marianneWeightName(v.weight);
  if (!w) return null;
  const italic = v.italic ? '_Italic' : '';
  return `Marianne-${w}${italic}.woff2`;
}

export const CURATED_FONTS: CuratedFont[] = [
  {
    family: 'Marianne',
    displayName: 'Marianne',
    // All 12 variants of the Marianne typeface. Confirmed available on
    // forge.apps.education.fr/drane-lyon/fonts (probed exhaustively).
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
    // Primary URL: Apps Education forge — has every variant.
    urlFor: (v) => {
      const name = marianneAppsEduFilename(v);
      return name ? `${APPS_EDU_MARIANNE}/${name}` : null;
    },
    fallbackUrlFor: (v) => {
      const name = marianneDsfrFilename(v);
      return name ? `${DSFR_FONTS}/${name}` : null;
    },
  },
];

export function findCuratedFont(family: string): CuratedFont | null {
  return CURATED_FONTS.find((f) => f.family === family) ?? null;
}

// Inject an @font-face rule for a given curated-font variant. Idempotent per
// (family, weight, italic) triple — calling twice with the same variant is a
// no-op.
//
// We point the `src` at our own /api/font proxy rather than the upstream
// CDN URL because some upstreams (e.g. forge.apps.education.fr) don't
// return CORS headers, and the browser refuses to load cross-origin
// fonts without `access-control-allow-origin`. Going through /api/font
// keeps the request same-origin and gives the burn pipeline and the
// preview the *same* font bytes (the server caches aggressively, so
// the decompress cost is one-time per variant).
export function loadCuratedFontVariant(font: CuratedFont, variant: FontVariant): void {
  if (typeof document === 'undefined') return;
  const id = `cf-remote-${font.family}-${variant.weight}-${variant.italic ? 'i' : 'n'}`;
  if (document.getElementById(id)) return;
  // Sanity check: only register a CSS rule if at least one CDN can serve
  // this variant. Avoids polluting the DOM with rules pointing at /api
  // URLs that 404 — the picker stays clean.
  const hasUpstream =
    font.urlFor(variant) !== null ||
    (font.fallbackUrlFor?.(variant) ?? null) !== null;
  if (!hasUpstream) return;
  const params = new URLSearchParams({
    family: font.family,
    weight: String(variant.weight),
  });
  if (variant.italic) params.set('italic', '1');
  const proxyUrl = `/api/font?${params.toString()}`;
  const el = document.createElement('style');
  el.id = id;
  el.textContent =
    `@font-face {` +
    ` font-family: "${font.family}";` +
    ` font-weight: ${variant.weight};` +
    ` font-style: ${variant.italic ? 'italic' : 'normal'};` +
    // Format hint omitted — the browser sniffs the file (the proxy may
    // serve OTF, TTF, or woff2 depending on the upstream).
    ` src: url("${proxyUrl}");` +
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
