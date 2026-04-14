'use client';

import { useEffect, useRef, useState } from 'react';
import type { ProjectFile } from '@/lib/project-file';
import { Button } from './ui/button';

// Shown when a user imports a .subifi.json project whose source video we
// couldn't auto-rehydrate from the IndexedDB cache (first import on a new
// machine, browser data cleared, file moved to a different repo, etc.).
//
// The modal is deliberately informational + terse — the edits have
// already been applied to the editor, we just need the video blob so the
// preview/burn can work. Dropping a mismatched file is allowed (soft
// warning); we don't block the user from continuing.

type Props = {
  project: ProjectFile | null;
  onPick: (file: File) => void;
  onClose: () => void;
};

export function ProjectImportModal({ project, onPick, onClose }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [blurReady, setBlurReady] = useState(false);
  const open = project !== null;

  useEffect(() => {
    if (!open) {
      setBlurReady(false);
      return;
    }
    const id = window.requestAnimationFrame(() => setBlurReady(true));
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || !project) return null;
  const m = project.manifest;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-4 transition-[backdrop-filter,background-color] duration-200 ease-out"
      style={{
        backgroundColor: blurReady ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0)',
        backdropFilter: blurReady ? 'blur(8px)' : 'blur(0px)',
        WebkitBackdropFilter: blurReady ? 'blur(8px)' : 'blur(0px)',
      }}
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-xl border border-border bg-bg-elev shadow-2xl transition-all duration-200 ease-out"
        style={{
          opacity: blurReady ? 1 : 0,
          transform: blurReady ? 'scale(1)' : 'scale(0.97)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="text-sm font-semibold text-text">Project imported</div>
          <button
            type="button"
            onClick={onClose}
            className="text-text-muted hover:text-text"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="flex flex-col gap-3 p-4 text-sm text-text">
          <p className="text-text-muted">
            Your edits are loaded. To preview and export, please attach the
            source video{m ? ' it was exported from' : ''}.
          </p>
          {m && (
            <div className="flex items-center gap-3 rounded-lg border border-border bg-bg-hi p-3">
              {m.coverDataUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={m.coverDataUrl}
                  alt="Project cover"
                  className="h-14 w-24 shrink-0 rounded object-cover"
                />
              )}
              <div className="min-w-0 flex-1 text-xs">
                <div className="truncate font-medium text-text" title={m.name}>
                  {m.name}
                </div>
                <div className="text-text-muted">
                  {formatBytes(m.size)} · {formatDuration(m.duration)}
                </div>
              </div>
            </div>
          )}
          <p className="text-xs text-text-muted">
            Dropping a different file still works — we&rsquo;ll warn you if
            it&rsquo;s not the exact match.
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Skip
          </Button>
          <Button variant="primary" size="sm" onClick={() => inputRef.current?.click()}>
            Choose video…
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept="video/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onPick(file);
              e.target.value = '';
            }}
          />
        </div>
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
