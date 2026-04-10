'use client';

import { useRef } from 'react';
import { useEditor } from '@/lib/store';

// Slim vertical sidebar with picto-only buttons for adding media overlays
// (text, image). Rendered twice: once on desktop (page.tsx, normal flow to
// the left of the preview) and once on mobile (inside VideoPreview's
// centering flex, to the left of the video box so it doesn't shift it).

export function MediaSidebar() {
  const {
    addOverlay,
    addTextOverlay,
    selectTextOverlay,
  } = useEditor();
  const imageInputRef = useRef<HTMLInputElement>(null);

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
      className="shrink-0 flex flex-col items-center gap-1 rounded-md border border-border bg-bg-elev p-1"
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
