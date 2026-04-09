// Minimal Google Fonts integration. We fetch a small curated list of families
// rather than the full catalog — for an internal tool, ~30 well-chosen
// families cover every reasonable use case and keep the picker browseable.

export const GOOGLE_FONTS: string[] = [
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
  'Playfair Display',
  'Bebas Neue',
  'Anton',
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
