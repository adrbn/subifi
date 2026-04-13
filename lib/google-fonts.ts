// Minimal Google Fonts integration. We fetch a small curated list of families
// rather than the full catalog — for an internal tool, ~30 well-chosen
// families cover every reasonable use case and keep the picker browseable.

export const GOOGLE_FONTS: string[] = [
  // ── Sans-Serif ──────────────────────────────────────────────
  'Inter',
  'Roboto',
  'Open Sans',
  'Lato',
  'Montserrat',
  'Poppins',
  'Oswald',
  'Raleway',
  'Ubuntu',
  'Nunito',
  'DM Sans',
  'Work Sans',
  'Archivo',
  'IBM Plex Sans',
  'Space Grotesk',
  'Rubik',
  'Fira Sans',
  'Source Sans 3',
  'Noto Sans',
  'PT Sans',
  'Libre Franklin',
  'Josefin Sans',
  'Barlow',
  'Manrope',
  'Cabin',
  'Titillium Web',
  'Kanit',
  'Lexend',
  'Outfit',
  'Plus Jakarta Sans',
  'Sora',
  'Urbanist',
  'Figtree',
  'Geist',
  'Red Hat Display',
  'Quicksand',
  'Comfortaa',
  'Exo 2',
  'Overpass',
  'Albert Sans',

  // ── Serif ───────────────────────────────────────────────────
  'Playfair Display',
  'Lora',
  'Merriweather',
  'PT Serif',
  'Libre Baskerville',
  'Source Serif 4',
  'Crimson Text',
  'EB Garamond',
  'Bitter',
  'DM Serif Display',
  'Cormorant Garamond',

  // ── Display / Impact ────────────────────────────────────────
  'Bebas Neue',
  'Anton',
  'Permanent Marker',
  'Righteous',
  'Bungee',
  'Orbitron',
  'Press Start 2P',
  'Monoton',
  'Silkscreen',
  'Russo One',
  'Black Ops One',
  'Bangers',
  'Passion One',
  'Teko',
  'Chakra Petch',

  // ── Handwriting / Script ────────────────────────────────────
  'Dancing Script',
  'Pacifico',
  'Caveat',
  'Satisfy',
  'Great Vibes',
  'Sacramento',
  'Lobster',
  'Kalam',
  'Patrick Hand',
  'Indie Flower',

  // ── Monospace ───────────────────────────────────────────────
  'Fira Code',
  'JetBrains Mono',
  'Source Code Pro',
  'IBM Plex Mono',
  'Space Mono',
];

// Inject a <link rel="stylesheet"> for a Google Font family so that the DOM
// preview can render it. Idempotent: calling twice with the same family is a
// no-op.
export function loadGoogleFont(family: string, weight = 700): void {
  if (typeof document === 'undefined') return;
  const id = `gf-${family.replace(/\s+/g, '-').toLowerCase()}-${weight}`;
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  // COEP: require-corp forces us to opt in to CORS for the stylesheet so the
  // browser will actually evaluate it in a cross-origin isolated document.
  link.crossOrigin = 'anonymous';
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(
    family,
  )}:wght@${weight}&display=swap`;
  document.head.appendChild(link);
}
