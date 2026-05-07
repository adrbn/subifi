import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { findCuratedFont, nearestVariant } from '@/lib/curated-fonts';

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

// Resolve a curated font (e.g. Marianne) to its OTF bytes. Curated
// fonts are pre-bundled under /public/fonts/curated/... so this is a
// straight `readFile` — no network, no decompression, no surprises.
//
// We snap the requested (weight, italic) to the nearest available
// variant so legacy projects using a weight that's missing from the
// bundled set still export cleanly.
async function fetchCurated(
  family: string,
  weight: number,
  italic: boolean,
): Promise<{ buf: Buffer; weight: number; italic: boolean } | null> {
  const font = findCuratedFont(family);
  if (!font) return null;
  const variant = nearestVariant(font, weight, italic);
  const url = font.urlFor(variant);
  // urlFor returns paths like `/fonts/curated/marianne/...` — strip the
  // leading slash and resolve against `process.cwd()/public/`.
  if (!url || !url.startsWith('/')) return null;
  // Defence-in-depth: confine reads to /public/fonts/curated/ so a
  // future bug in `urlFor` can't escape into the rest of the disk.
  if (!url.startsWith('/fonts/curated/')) {
    console.warn(
      `[api/font] curated font url outside /fonts/curated/, refusing: ${url}`,
    );
    return null;
  }
  const filePath = join(process.cwd(), 'public', url.replace(/^\//, ''));
  try {
    const buf = await readFile(filePath);
    return { buf, weight: variant.weight, italic: variant.italic };
  } catch (err) {
    console.warn(
      `[api/font] curated font read failed for ${family}@${weight}${italic ? 'i' : ''}`,
      { filePath, err },
    );
    return null;
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const family = searchParams.get('family')?.trim();
  const weightRaw = searchParams.get('weight')?.trim() ?? '400';
  const weight = Number(weightRaw);
  const subset = searchParams.get('subset')?.trim() ?? 'latin';
  // Accept `italic=1` (or `true`) so curated fonts can serve italic
  // variants. Google Fonts requests don't currently use this param —
  // burn-in.ts asks for upright weights only and applies italics via
  // the libass `\i1` tag at render time.
  const italic = ['1', 'true', 'yes'].includes(
    (searchParams.get('italic') ?? '').toLowerCase(),
  );

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

  // Curated fonts (Marianne, etc.) take priority — they're not on
  // Google Fonts and ship as static OTF assets under /public.
  // `findCuratedFont` is fast (linear scan over a tiny list) so the
  // common Google-Font path pays no measurable overhead.
  const curated = await fetchCurated(family, weight, italic);
  if (curated) {
    const headers: Record<string, string> = {
      'content-type': 'font/otf',
      'content-length': String(curated.buf.byteLength),
      'cache-control': 'public, max-age=31536000, immutable',
      'cross-origin-resource-policy': 'same-origin',
    };
    // Surface the actual variant the server delivered so burn-in.ts can
    // log it. Useful when the requested weight doesn't exist and we
    // snapped to the nearest available one.
    if (curated.weight !== weight) {
      headers['x-font-resolved-weight'] = String(curated.weight);
    }
    if (curated.italic !== italic) {
      headers['x-font-resolved-italic'] = String(curated.italic);
    }
    // Convert Node Buffer → ArrayBuffer slice for Response/BodyInit
    // typing. The bytes are identical; only the JS view differs.
    const body = curated.buf.buffer.slice(
      curated.buf.byteOffset,
      curated.buf.byteOffset + curated.buf.byteLength,
    ) as ArrayBuffer;
    return new Response(body, { status: 200, headers });
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
