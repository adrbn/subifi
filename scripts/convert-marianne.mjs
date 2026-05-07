import { decompress } from 'wawoff2';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '../public/fonts/curated/marianne');
const BASE = 'https://forge.apps.education.fr/drane-lyon/fonts/-/raw/main';

const VARIANTS = [];
for (const w of ['Thin', 'Light', 'Regular', 'Medium', 'Bold', 'ExtraBold']) {
  VARIANTS.push(`Marianne-${w}.woff2`);
  VARIANTS.push(`Marianne-${w}_Italic.woff2`);
}

await mkdir(OUT_DIR, { recursive: true });

for (const name of VARIANTS) {
  const url = `${BASE}/${name}`;
  process.stdout.write(`${name} ... `);
  try {
    const res = await fetch(url);
    if (!res.ok) { console.log(`HTTP ${res.status} — skip`); continue; }
    const woff2 = new Uint8Array(await res.arrayBuffer());
    const otf = await decompress(woff2);
    const outName = name.replace('.woff2', '.otf');
    await writeFile(resolve(OUT_DIR, outName), otf);
    console.log(`OK (${woff2.length} → ${otf.length} bytes)`);
  } catch (err) {
    console.log(`FAIL: ${err.message}`);
  }
}
