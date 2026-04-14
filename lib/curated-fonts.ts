// Curated remote fonts that aren't on Google Fonts but we want first-class.
// Each family declares its available weight/italic variants and a URL
// resolver so the picker can inject @font-face rules on demand.
//
// Marianne is the official French government typeface, shipped via the DSFR
// (Système de Design de l'État) package on npm. jsDelivr mirrors the npm
// distribution so we can pull woff2 files directly from the CDN without
// self-hosting.

export type FontVariant = {
  weight: number;
  italic: boolean;
  label: string;         // "Regular", "Bold Italic", etc. — shown in the picker
};

export type CuratedFont = {
  family: string;        // CSS font-family name we register via @font-face
  displayName: string;   // what the picker shows
  variants: FontVariant[];
  // Resolve the CDN URL for a given variant. Returning null means "not available".
  urlFor: (v: FontVariant) => string | null;
};

// jsDelivr CDN path for @gouvfr/dsfr. Pinned to a version so behaviour is
// reproducible — bump when the DSFR team ships a font update.
const DSFR_VERSION = '1.13.0';
const DSFR_FONTS = `https://cdn.jsdelivr.net/npm/@gouvfr/dsfr@${DSFR_VERSION}/dist/fonts`;

function marianneFilename(v: FontVariant): string {
  const weightName =
    v.weight === 100 ? 'Thin' :
    v.weight === 300 ? 'Light' :
    v.weight === 400 ? 'Regular' :
    v.weight === 500 ? 'Medium' :
    v.weight === 700 ? 'Bold' :
    v.weight === 800 ? 'ExtraBold' :
    null;
  if (!weightName) return '';
  const italic = v.italic ? '_Italic' : '';
  return `Marianne-${weightName}${italic}.woff2`;
}

export const CURATED_FONTS: CuratedFont[] = [
  {
    family: 'Marianne',
    displayName: 'Marianne',
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
    urlFor: (v) => {
      const name = marianneFilename(v);
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
    ` src: url("${url}") format("woff2");` +
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
