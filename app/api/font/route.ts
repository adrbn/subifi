import { NextResponse } from 'next/server';

// Server-side proxy that returns TTF font binaries for any Google Font.
//
// Why this exists: ffmpeg-wasm's libass uses freetype, and the freetype build
// shipped with @ffmpeg/core-mt does NOT include brotli — meaning it cannot
// decode woff2 fonts. We need real TTF bytes. We also can't fetch them from
// the browser directly because we can't set the User-Agent header that
// fonts.googleapis.com inspects to decide which format to serve.
//
// Strategy (in order):
//   1. Fontsource via jsdelivr CDN — serves static TTFs for every Google
//      Font, content-addressed and cacheable. This is the primary path
//      because it works for newer variable-only Google Fonts (e.g. Archivo)
//      where the legacy-UA scraping trick stopped returning TTF URLs.
//   2. Google Fonts CSS scrape with a legacy UA — fallback for fonts that
//      Fontsource doesn't ship. Increasingly broken for newer/variable
//      fonts but still useful for the long tail.
//
// Both paths return font/ttf bytes that burn-in.ts then UU-encodes into the
// ASS [Fonts] section. The ffmpeg-wasm libass build also lacks fontconfig,
// so directory-loaded fonts wouldn't work even if we wrote them — embedded
// fonts are the only mechanism that actually renders glyphs.

export const runtime = 'nodejs';
export const maxDuration = 30;

// IE9-era UA — Google Fonts has been serving TTF to this string for a decade
// for non-variable fonts. We still try this as a fallback when Fontsource
// doesn't have a font.
const LEGACY_UA =
  'Mozilla/5.0 (Windows NT 6.1; WOW64; rv:9.0.1) Gecko/20100101 Firefox/9.0.1';

// Allow .ttf URLs with optional query strings — Google's CDN sometimes
// appends a cache-busting query so the strict `.ttf)` form misses them.
const TTF_URL_RE = /url\((https:[^)]+?\.ttf(?:\?[^)]*)?)\)/;

// Convert a Google Fonts display name into a Fontsource package id.
// "Archivo" → "archivo", "Source Sans 3" → "source-sans-3",
// "Plus Jakarta Sans" → "plus-jakarta-sans".
function familyToFontsourceId(family: string): string {
  return family
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Try Fontsource first. Returns the TTF bytes or null on miss.
// `subset` defaults to 'latin' but callers can request e.g.
// 'chinese-simplified' for CJK fallback fonts.
async function fetchFromFontsource(
  family: string,
  weight: number,
  subset: string = 'latin',
): Promise<ArrayBuffer | null> {
  const id = familyToFontsourceId(family);
  const candidates = [
    `https://cdn.jsdelivr.net/fontsource/fonts/${id}@latest/${subset}-${weight}-normal.ttf`,
    `https://cdn.jsdelivr.net/fontsource/fonts/${id}:vf@latest/${subset}-wght-normal.ttf`,
  ];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { cache: 'force-cache' });
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      if (buf.byteLength > 0) return buf;
    } catch {
      // Try next candidate
    }
  }
  return null;
}

// Fallback: scrape a TTF URL out of Google Fonts CSS using a legacy UA.
async function fetchFromGoogleCss(
  family: string,
  weight: number,
): Promise<ArrayBuffer | null> {
  const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(
    family,
  )}:wght@${weight}&display=swap`;

  let cssRes: Response;
  try {
    cssRes = await fetch(cssUrl, {
      headers: { 'User-Agent': LEGACY_UA },
      cache: 'force-cache',
    });
  } catch {
    return null;
  }
  if (!cssRes.ok) return null;

  const css = await cssRes.text();
  const match = css.match(TTF_URL_RE);
  if (!match) return null;

  let ttfUrl: URL;
  try {
    ttfUrl = new URL(match[1]);
  } catch {
    return null;
  }
  // SSRF guard: only allow gstatic.com.
  if (ttfUrl.hostname !== 'fonts.gstatic.com') return null;

  try {
    const ttfRes = await fetch(ttfUrl.toString(), { cache: 'force-cache' });
    if (!ttfRes.ok) return null;
    return await ttfRes.arrayBuffer();
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const family = searchParams.get('family')?.trim();
  const weightRaw = searchParams.get('weight')?.trim() ?? '400';
  const weight = Number(weightRaw);
  const subset = searchParams.get('subset')?.trim() ?? 'latin';

  if (!family) {
    return NextResponse.json(
      { error: 'family query param required' },
      { status: 400 },
    );
  }
  if (!Number.isFinite(weight) || weight < 100 || weight > 900) {
    return NextResponse.json(
      { error: 'weight must be a number between 100 and 900' },
      { status: 400 },
    );
  }
  if (family.length > 80) {
    return NextResponse.json(
      { error: 'family name too long' },
      { status: 400 },
    );
  }
  if (subset.length > 40 || !/^[a-z0-9-]+$/.test(subset)) {
    return NextResponse.json(
      { error: 'invalid subset value' },
      { status: 400 },
    );
  }

  // Try Fontsource (reliable static TTFs), fall back to Google CSS scrape.
  let buf = await fetchFromFontsource(family, weight, subset);
  if (!buf) {
    buf = await fetchFromGoogleCss(family, weight);
  }
  if (!buf || buf.byteLength === 0) {
    return NextResponse.json(
      {
        error: `no TTF available for family "${family}" @ weight ${weight}. ` +
          'Tried Fontsource and Google Fonts CSS scrape.',
      },
      { status: 404 },
    );
  }

  return new Response(buf, {
    status: 200,
    headers: {
      'content-type': 'font/ttf',
      'content-length': String(buf.byteLength),
      // 1 year — fonts are content-addressed and our cache key is
      // family+weight, so a new version means a new request anyway.
      'cache-control': 'public, max-age=31536000, immutable',
      'cross-origin-resource-policy': 'same-origin',
    },
  });
}
