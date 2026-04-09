'use client';

import { useEffect, useRef } from 'react';
import { GOOGLE_FONTS, loadGoogleFont } from '@/lib/google-fonts';
import { useEditor } from '@/lib/store';
import { Select } from './ui/select';
import { Button } from './ui/button';
import type { CustomFont } from '@/lib/types';

function extFromName(name: string): CustomFont['format'] {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'otf') return 'otf';
  if (ext === 'woff') return 'woff';
  if (ext === 'woff2') return 'woff2';
  return 'ttf';
}

function mimeForFormat(format: CustomFont['format']): string {
  switch (format) {
    case 'otf':
      return 'font/otf';
    case 'woff':
      return 'font/woff';
    case 'woff2':
      return 'font/woff2';
    default:
      return 'font/ttf';
  }
}

// Injects a custom font into the document via @font-face so the DOM preview
// can render text with it. Idempotent per family name.
function injectCustomFont(font: CustomFont) {
  if (typeof document === 'undefined') return;
  const id = `cf-${font.name}`;
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = `@font-face { font-family: "${font.name}"; src: url("${font.dataUrl}") format("${font.format === 'ttf' ? 'truetype' : font.format}"); font-display: swap; }`;
  document.head.appendChild(style);
}

export function FontPicker() {
  const { style, setStyle, addCustomFont, customFonts } = useEditor();
  const fileRef = useRef<HTMLInputElement>(null);

  // Re-inject custom fonts whenever the list changes (handles hot reload in
  // dev). The injection itself is idempotent.
  useEffect(() => {
    customFonts.forEach(injectCustomFont);
  }, [customFonts]);

  // Preload the currently-selected Google Font so the preview shows it
  // immediately even before the user clicks anything in the preset list.
  useEffect(() => {
    if (GOOGLE_FONTS.includes(style.fontFamily)) {
      loadGoogleFont(style.fontFamily, style.fontWeight);
    }
  }, [style.fontFamily, style.fontWeight]);

  const onUpload = async (file: File) => {
    const buffer = await file.arrayBuffer();
    const format = extFromName(file.name);
    const name = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
    // data URL so we can embed it in @font-face without needing a blob URL.
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
    const dataUrl = `data:${mimeForFormat(format)};base64,${b64}`;
    const font: CustomFont = { name, dataUrl, buffer, format };
    addCustomFont(font);
    injectCustomFont(font);
    setStyle({ fontFamily: name });
  };

  const allFamilies = [
    ...customFonts.map((f) => ({ name: f.name, group: 'Custom' })),
    ...GOOGLE_FONTS.map((f) => ({ name: f, group: 'Google Fonts' })),
  ];

  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs text-text-muted">Font family</label>
      <div className="flex gap-2">
        <Select
          value={style.fontFamily}
          onChange={(e) => {
            const family = e.target.value;
            setStyle({ fontFamily: family });
            if (GOOGLE_FONTS.includes(family)) loadGoogleFont(family, style.fontWeight);
          }}
        >
          {customFonts.length > 0 && (
            <optgroup label="Custom">
              {customFonts.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.name}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Google Fonts">
            {GOOGLE_FONTS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </optgroup>
        </Select>
        <Button
          variant="secondary"
          size="md"
          onClick={() => fileRef.current?.click()}
          title="Upload a custom font (.ttf, .otf, .woff, .woff2)"
        >
          +
        </Button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".ttf,.otf,.woff,.woff2,font/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onUpload(file);
        }}
      />
      {/* Silent helper so the <select> above maps to a typed array */}
      <input type="hidden" value={allFamilies.length} readOnly />
    </div>
  );
}
