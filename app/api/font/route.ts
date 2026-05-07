import { NextResponse } from 'next/server';
import { decompress as wawoff2Decompress } from 'wawoff2';
import { findCuratedFont, nearestVariant } from '@/lib/curated-fonts';

// `wawoff2` is a pure-JS port of Google's woff2 tool. We use it to
// decompress the woff2 files that curated CDNs ship into TTF/OTF bytes
// that ffmpeg-wasm's freetype build can actually read (freetype-wasm
// has no brotli, so it silently rejects woff2). The decompress()
// output for Marianne is OpenType (magic 0x4F54544F = 'OTTO'), which
// our burn pipeline already accepts.
//
// Static import + `serverExternalPackages: ['wawoff2']` in next.config
// is more reliable on Vercel than dynamic import — webpack can't
// trace the inline-base64 wasm in wawoff2's emscripten output, so
// trying to bundle it fails the build.
async function decompressWoff2(woff2: ArrayBuffer): Promise<ArrayBuffer> {
  const out = await wawoff2Decompress(new Uint8Array(woff2));
  return out.buffer.slice(
    out.byteOffset,
    out.byteOffset + out.byteLength,
  ) as ArrayBuffer;
}

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

// SSRF allowlist — curated fonts can only come from these hosts. Any other
// URL configured in lib/curated-fonts.ts will be rejected before we make
// the outbound request. Add entries here when you onboard a new curated
// font from a different CDN.
const CURATED_HOSTS = new Set<string>([
  'forge.apps.education.fr',
  'cdn.jsdelivr.net',
]);

async function fetchWoff2AndDecompress(url: string): Promise<ArrayBuffer | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!CURATED_HOSTS.has(parsed.hostname)) return null;
  let res: Response;
  try {
    res = await fetch(parsed.toString(), { cache: 'force-cache' });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const woff2 = await res.arrayBuffer();
  if (woff2.byteLength === 0) return null;
  try {
    return await decompressWoff2(woff2);
  } catch (err) {
    console.warn('[api/font] wawoff2 decompress failed', { url, err });
    return null;
  }
}

// Resolve a curated font (e.g. Marianne) to a TTF/OTF buffer. Steps:
//   1. Snap the requested (weight, italic) to the nearest available variant
//      so legacy projects using a weight that's missing from the primary
//      CDN keep exporting cleanly.
//   2. Try the primary CDN's woff2; on failure try the fallback CDN.
//   3. Decompress to OTF/TTF via wawoff2 so freetype-wasm can read it.
async function fetchCurated(
  family: string,
  weight: number,
  italic: boolean,
): Promise<{ buf: ArrayBuffer; weight: number; italic: boolean } | null> {
  const font = findCuratedFont(family);
  if (!font) return null;
  const variant = nearestVariant(font, weight, italic);
  const primary = font.urlFor(variant);
  if (primary) {
    const buf = await fetchWoff2AndDecompress(primary);
    if (buf) {
      return { buf, weight: variant.weight, italic: variant.italic };
    }
  }
  // Primary failed — fall back to the secondary if the variant is on it.
  const fallback = font.fallbackUrlFor?.(variant) ?? null;
  if (fallback) {
    const buf = await fetchWoff2AndDecompress(fallback);
    if (buf) {
      console.info(
        `[api/font] used fallback CDN for ${family}@${weight}${italic ? 'i' : ''}`,
      );
      return { buf, weight: variant.weight, italic: variant.italic };
    }
  }
  return null;
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

  // Curated fonts (Marianne, etc.) take priority — they're not on Google
  // Fonts and have to be fetched + decompressed from their own CDN.
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
    return new Response(curated.buf, { status: 200, headers });
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
