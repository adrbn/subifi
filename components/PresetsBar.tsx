'use client';

import { useEffect, useRef, useState } from 'react';
import { useEditor } from '@/lib/store';
import { DEFAULT_STYLE, SEGMENTATION_PRESETS, STYLE_PRESETS } from '@/lib/presets';
import {
  addUserPreset,
  loadUserPresets,
  removeUserPreset,
  type UserStylePreset,
} from '@/lib/user-presets';
import { exportStyles, parseStyleFile } from '@/lib/style-file';
import { downloadBlob } from '@/lib/download';
import { Button } from './ui/button';
import {
  deleteSharedPreset,
  listSharedPresets,
  publishSharedPreset,
  type SharedPreset,
} from '@/lib/shared-presets-client';
import { GOOGLE_FONTS, loadGoogleFont } from '@/lib/google-fonts';
import { findCuratedFont, loadCuratedFontFamily } from '@/lib/curated-fonts';
import type { Style } from '@/lib/types';

export function PresetsBar() {
  const { style, applyStylePreset, resegment } = useEditor();
  const [userPresets, setUserPresets] = useState<UserStylePreset[]>([]);
  const [sharedPresets, setSharedPresets] = useState<SharedPreset[]>([]);

  // Hydrate from localStorage on mount. We don't read in the initial state
  // because that would run during SSR and crash the build.
  useEffect(() => {
    setUserPresets(loadUserPresets());
  }, []);

  // Best-effort fetch of the community preset library. Fails silently — the
  // bar just won't show a Shared section, which is fine.
  useEffect(() => {
    void (async () => {
      const list = await listSharedPresets();
      setSharedPresets(list);
      // Preload fonts referenced by shared presets so clicking a chip
      // doesn't briefly render in the fallback font (which typically has
      // a smaller x-height and makes the preset look smaller than the
      // author intended).
      for (const p of list) {
        const fam = p.style.fontFamily;
        if (GOOGLE_FONTS.includes(fam)) loadGoogleFont(fam, p.style.fontWeight);
        else if (findCuratedFont(fam)) loadCuratedFontFamily(fam);
      }
    })();
  }, []);

  // Apply a preset while guaranteeing its font is loaded. Both built-in
  // and shared presets go through this so the visual parity matches what
  // the author saw when they published.
  const applyPresetWithFont = (presetStyle: Style) => {
    const fam = presetStyle.fontFamily;
    if (GOOGLE_FONTS.includes(fam)) loadGoogleFont(fam, presetStyle.fontWeight);
    else if (findCuratedFont(fam)) loadCuratedFontFamily(fam);
    applyStylePreset({ ...DEFAULT_STYLE, ...presetStyle });
  };

  const onPublishPreset = async (p: UserStylePreset) => {
    if (!window.confirm(`Publish "${p.label}" to the shared library?`)) return;
    const published = await publishSharedPreset(p.label, p.style);
    if (!published) {
      alert('Publish failed. Please try again later.');
      return;
    }
    // Optimistic-ish: prepend so the user sees their contribution right away.
    setSharedPresets((prev) => [published, ...prev]);
  };

  // Deletion is public (no auth) — matches the rest of the shared-library
  // design. Confirm to prevent accidental click-throughs, then optimistically
  // remove from the visible list.
  const onDeleteSharedPreset = async (p: SharedPreset) => {
    if (!window.confirm(`Remove "${p.label}" from the shared library?`)) return;
    const ok = await deleteSharedPreset(p.id);
    if (!ok) {
      alert('Delete failed. Please try again later.');
      return;
    }
    setSharedPresets((prev) => prev.filter((x) => x.id !== p.id));
  };

  const styleInputRef = useRef<HTMLInputElement>(null);

  const onImportStyles = async (file: File) => {
    try {
      const json = await file.text();
      const entries = parseStyleFile(json);
      for (const entry of entries) {
        addUserPreset(entry.label, entry.style);
      }
      setUserPresets(loadUserPresets());
    } catch (err) {
      alert(`Import failed: ${err instanceof Error ? err.message : 'Invalid file'}`);
    }
  };

  const onSaveCurrent = () => {
    // window.prompt is intentional — small modal-free UX for a feature that
    // would otherwise need a dedicated dialog component.
    const label = window.prompt('Name this preset:', 'My style');
    if (!label) return;
    addUserPreset(label.trim() || 'Untitled', style);
    setUserPresets(loadUserPresets());
  };

  const onDeletePreset = (id: string) => {
    removeUserPreset(id);
    setUserPresets(loadUserPresets());
  };

  return (
    // Each parameter group lives on its own row so the labels don't bleed
    // into each other ("Style preset" and "Segmentation" used to share a
    // line and felt like one section). Both rows are independently
    // horizontally scrollable on mobile when the button row overflows.
    <div data-tour="presets" className="flex flex-col gap-1.5">
      <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 sm:mx-0 sm:flex-wrap sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <span className="w-20 shrink-0 text-xs uppercase tracking-wider text-text-muted">
          Style
        </span>
        {STYLE_PRESETS.map((p) => (
          <Button
            key={p.id}
            variant="secondary"
            size="sm"
            className="shrink-0"
            onClick={() => applyPresetWithFont(p.style)}
          >
            {p.label}
          </Button>
        ))}
        {/* User-saved presets. × removes, ↑ publishes to the shared
            library. Both are guarded so a click on them doesn't also fire
            the apply handler. */}
        {userPresets.map((p) => (
          <div
            key={p.id}
            className="group flex shrink-0 items-stretch overflow-hidden rounded-md border border-border"
          >
            <button
              type="button"
              // Merge over DEFAULT_STYLE so presets saved before a new
              // Style field was added still apply cleanly.
              onClick={() => applyPresetWithFont(p.style)}
              className="bg-bg-elev px-2 py-1 text-xs text-text hover:bg-bg-hi"
              title={`Apply preset "${p.label}"`}
            >
              {p.label}
            </button>
            <button
              type="button"
              onClick={() => void onPublishPreset(p)}
              className="border-l border-border bg-bg-elev px-1.5 text-xs text-text-muted hover:bg-accent/30 hover:text-text"
              title="Publish this preset to the shared library"
            >
              ↑
            </button>
            <button
              type="button"
              onClick={() => onDeletePreset(p.id)}
              className="border-l border-border bg-bg-elev px-1.5 text-xs text-text-muted hover:bg-red-900/40 hover:text-red-200"
              title="Delete this preset"
            >
              ×
            </button>
          </div>
        ))}
        {/* Shared library presets — read-only chips. Applying one copies
            its style into the current editor state (same path as a built-in). */}
        {sharedPresets.length > 0 && (
          <span
            className="mx-1 h-5 w-px shrink-0 bg-border/60"
            aria-hidden="true"
          />
        )}
        {sharedPresets.map((p) => (
          <div
            key={p.id}
            className="group flex shrink-0 items-stretch overflow-hidden rounded-md border border-border"
          >
            <button
              type="button"
              onClick={() => applyPresetWithFont(p.style)}
              className="bg-bg-elev px-2 py-1 text-xs italic text-text hover:bg-bg-hi"
              title={`Shared preset · ${p.label}`}
            >
              {p.label}
            </button>
            <button
              type="button"
              onClick={() => void onDeleteSharedPreset(p)}
              className="border-l border-border bg-bg-elev px-1.5 text-xs text-text-muted hover:bg-red-900/40 hover:text-red-200"
              title="Remove this preset from the shared library (no auth — visible to everyone)"
            >
              ×
            </button>
          </div>
        ))}
        {/* Divider separates preset chips (apply) from preset management
            actions (save / export / import) — they're conceptually different. */}
        <span
          className="mx-1 h-5 w-px shrink-0 bg-border"
          aria-hidden="true"
        />
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0"
          onClick={onSaveCurrent}
          title="Save the current style as a reusable preset"
        >
          + Save
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0"
          disabled={userPresets.length === 0}
          onClick={() => {
            if (userPresets.length === 0) return;
            const json = exportStyles(userPresets);
            downloadBlob(json, 'styles.subifi-styles.json', 'application/json');
          }}
          title="Export all saved presets as a file"
        >
          Export
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0"
          onClick={() => styleInputRef.current?.click()}
          title="Import presets from a file"
        >
          Import
        </Button>
        <input
          ref={styleInputRef}
          type="file"
          accept=".json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void onImportStyles(file);
            e.target.value = '';
          }}
        />
      </div>
      <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 sm:mx-0 sm:flex-wrap sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <span className="w-20 shrink-0 text-xs uppercase tracking-wider text-text-muted">
          Coupe
        </span>
        <Button
          variant="secondary"
          size="sm"
          className="shrink-0"
          onClick={() => resegment(SEGMENTATION_PRESETS.cinema)}
        >
          Cinéma
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="shrink-0"
          onClick={() => resegment(SEGMENTATION_PRESETS.tiktok)}
        >
          TikTok
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="shrink-0"
          onClick={() => resegment(SEGMENTATION_PRESETS.word)}
          title="One word per subtitle block — pairs well with the Karaoke style preset"
        >
          One word
        </Button>
      </div>
    </div>
  );
}
