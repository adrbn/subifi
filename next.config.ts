import type { NextConfig } from 'next';

// COOP/COEP are required so the page is cross-origin isolated and
// SharedArrayBuffer becomes available. SAB is a prerequisite for the
// multi-threaded ffmpeg core (lib/ffmpeg-client.ts), which is ~2-3x faster
// than the single-threaded core on burn operations.
//
// Because this puts us in a cross-origin isolated context, every third-party
// resource must serve with CORP (Cross-Origin-Resource-Policy) or be
// requested with `crossorigin="anonymous"` + CORS headers:
//   - Google Fonts CSS + gstatic fonts: supported via the crossOrigin attr
//     added in lib/google-fonts.ts and the crossOrigin on the CSS fetch in
//     lib/burn-in.ts.
//   - unpkg ffmpeg core/worker/wasm: unpkg serves CORP-compatible headers.

const COOP_COEP_HEADERS = [
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: COOP_COEP_HEADERS,
      },
    ];
  },
  webpack: (config) => {
    config.resolve.fallback = { ...config.resolve.fallback, fs: false };
    return config;
  },
};

export default nextConfig;
