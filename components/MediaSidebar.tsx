'use client';

import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { useEditor } from '@/lib/store';

// Slim vertical sidebar sitting immediately to the left of the video
// preview. Hosts picto-only buttons for adding media that layers on top of
// the video (text overlays, image overlays). The bar is intentionally
// narrow (w-8) so it doesn't eat into the preview; its height is driven
// by the number of pictos inside, so adding new options later just makes
// the column a bit taller without any layout surgery elsewhere.
//
// Mobile + landscape video special case: a vertical bar next to a 16:9
// video on a 375px-wide phone squashes the preview to a useless thumbnail
// (it has to fit width × 9/16 of height alongside a fixed-width column).
// In that one combination we re-style the sidebar as a small horizontal
// pill ABSOLUTELY positioned over the top of the video, so the preview
// gets the full container width. The parent flex row in app/page.tsx is
// `relative` so this absolute positioning anchors correctly.

export function MediaSidebar() {
  const {
    addOverlay,
    addTextOverlay,
    selectTextOverlay,
    videoWidth,
    videoHeight,
  } = useEditor();
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [isMobile, setIsMobile] = useState(false);

  // Track the md breakpoint (Tailwind default = 768px). Matches the same
  // threshold app/page.tsx uses for its desktop / mobile layout switch so
  // the two stay in sync.
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  // Landscape = wider than tall. Falls through to the "vertical adjacent"
  // layout for square / unknown sizes since those still leave usable
  // horizontal room next to the preview.
  const isLandscape = videoWidth > 0 && videoHeight > 0 && videoWidth > videoHeight;
  const overlayMode = isMobile;

  const onAddText = () => {
    const id = addTextOverlay();
    // The store already selects it, but we re-select explicitly so anything
    // listening on `selectTextOverlay` (e.g. the right panel focusing the
    // new entry) fires predictably.
    selectTextOverlay(id);
  };

  const onImageFile = async (file: File) => {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    addOverlay({
      dataUrl,
      mime: file.type || 'image/png',
      positionX: 0.85,
      positionY: 0.12,
      width: 0.15,
      opacity: 1,
    });
  };

  return (
    <div
      data-tour="media-sidebar"
      className={clsx(
        'shrink-0 rounded-md border border-border p-1',
        overlayMode
          ? // Floating horizontal pill over the top-center of the preview.
            // bg-elev/85 + backdrop-blur keeps the buttons readable without
            // hiding the video underneath.
            'absolute left-1/2 top-3 z-20 flex -translate-x-1/2 flex-row items-center gap-1 bg-bg-elev/85 backdrop-blur-sm'
          : 'flex flex-col items-center gap-1 self-start bg-bg-elev',
      )}
    >
      <button
        type="button"
        onClick={onAddText}
        className="flex h-7 w-7 items-center justify-center rounded text-text-muted transition-colors hover:bg-bg-hi hover:text-text"
        title="Add text overlay"
        aria-label="Add text overlay"
      >
        <span className="text-sm font-bold leading-none">T</span>
      </button>
      <button
        type="button"
        onClick={() => imageInputRef.current?.click()}
        className="flex h-7 w-7 items-center justify-center rounded text-text-muted transition-colors hover:bg-bg-hi hover:text-text"
        title="Add image overlay"
        aria-label="Add image overlay"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          width="15"
          height="15"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
      </button>
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onImageFile(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}
