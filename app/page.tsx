'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { useEditor } from '@/lib/store';
import {
  clearSession,
  loadSession,
  saveSession,
  type SessionSnapshot,
} from '@/lib/persist';
import { Dropzone } from '@/components/Dropzone';
import { VideoPreview } from '@/components/VideoPreview';
import { SubtitleList } from '@/components/SubtitleList';
import { Timeline } from '@/components/Timeline';
import { StylePanel } from '@/components/StylePanel';
import { PresetsBar } from '@/components/PresetsBar';
import { ExportBar } from '@/components/ExportBar';
import { TranslateBar } from '@/components/TranslateBar';
import { TranscribeButton } from '@/components/TranscribeButton';
import { ExportMp4Button } from '@/components/ExportMp4Button';
import { FeedbackButton } from '@/components/FeedbackButton';
import { MediaSidebar } from '@/components/MediaSidebar';
import { OnboardingTour } from '@/components/OnboardingTour';
import { Button } from '@/components/ui/button';

// Clamp helpers for the draggable preview/bottom splitter (desktop only).
const PREVIEW_PCT_MIN = 25;
const PREVIEW_PCT_MAX = 85;
const PREVIEW_PCT_DEFAULT = 62;
const PREVIEW_PCT_STORAGE_KEY = 'subifi:previewPct';

// Main page. Two layouts share the same data:
//  - Desktop (md+): hybrid — preview + timeline + subtitle list on the left
//    column, StylePanel on the right as a fixed sidebar.
//  - Mobile (<md):  everything stacks. The right sidebar is replaced by a
//    bottom tab bar that swaps the subtitle list area between the list and
//    the StylePanel. The splitter is hidden because there's no meaningful
//    horizontal space to redistribute.

type MobileTab = 'subs' | 'style';

export default function Page() {
  const {
    videoUrl,
    clearVideo,
    status,
    progress,
    error,
    setStatus,
    undo,
    redo,
    past,
    future,
    blocks,
  } = useEditor();
  const canUndo = past.length > 0;
  const canRedo = future.length > 0;
  // Tour readiness: a video is loaded AND we have at least one subtitle
  // block, so all the data-tour anchors actually exist in the DOM.
  const tourReady = Boolean(videoUrl) && blocks.length > 0;

  const leftColRef = useRef<HTMLDivElement>(null);
  const [previewPct, setPreviewPct] = useState<number>(PREVIEW_PCT_DEFAULT);
  const [splitterDragging, setSplitterDragging] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobileTab>('subs');
  const [isDesktop, setIsDesktop] = useState(false);
  // Gate persistence until the initial hydrate pass has had a chance to
  // run. Without this, the first sync render would subscribe with empty
  // state and immediately save an "empty" snapshot over the real one.
  const hydratedRef = useRef(false);
  const [sessionRestored, setSessionRestored] = useState(false);

  // Track the md breakpoint (Tailwind default = 768px) so we can apply the
  // splitter's percentage only on desktop and a clamped vh on mobile.
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  // Restore preview height from localStorage once on mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PREVIEW_PCT_STORAGE_KEY);
      if (raw) {
        const n = Number(raw);
        if (!Number.isNaN(n)) {
          setPreviewPct(Math.max(PREVIEW_PCT_MIN, Math.min(PREVIEW_PCT_MAX, n)));
        }
      }
    } catch {
      // ignore — SSR or blocked storage
    }
  }, []);

  // Persist preview height.
  useEffect(() => {
    try {
      localStorage.setItem(PREVIEW_PCT_STORAGE_KEY, String(previewPct));
    } catch {
      // ignore
    }
  }, [previewPct]);

  // --- Session auto-save / auto-restore ------------------------------------
  // On mount, try to rehydrate from the last saved IndexedDB snapshot. This
  // lets the user accidentally close the tab and come back to exactly where
  // they left off (video, audio, transcription, style, overlays, fonts).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const snapshot = await loadSession();
        if (!cancelled && snapshot && snapshot.videoFile) {
          useEditor.getState().hydrate(snapshot);
          setSessionRestored(true);
        }
      } finally {
        // Always mark hydrated — even if there was nothing to restore — so
        // the save subscription can start doing its thing.
        hydratedRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounced save: 800ms after the last state change, push a fresh
  // snapshot to IndexedDB. Subscribing via `useEditor.subscribe` gives us
  // every mutation without re-rendering the page.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = useEditor.subscribe((state) => {
      if (!hydratedRef.current) return;
      // No video, nothing worth saving. The explicit clear path (below)
      // handles cleaning up a previously-saved session.
      if (!state.videoFile) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const snapshot: SessionSnapshot = {
          version: 1,
          savedAt: Date.now(),
          videoFile: state.videoFile,
          videoDuration: state.videoDuration,
          videoWidth: state.videoWidth,
          videoHeight: state.videoHeight,
          extractedAudio: state.extractedAudio,
          words: state.words,
          blocks: state.blocks,
          style: state.style,
          segmentation: state.segmentation,
          customFonts: state.customFonts,
          overlays: state.overlays,
          selectedOverlayId: state.selectedOverlayId,
          textOverlays: state.textOverlays,
          selectedTextOverlayId: state.selectedTextOverlayId,
          safeZone: state.safeZone,
          cuts: state.cuts,
          subtitleTracks: state.subtitleTracks,
          activeTrackId: state.activeTrackId,
        };
        void saveSession(snapshot);
      }, 800);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsub();
    };
  }, []);

  // Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z (or Cmd/Ctrl+Y) for undo/redo. We
  // intentionally let plain Z reach textareas/inputs — only the modified
  // shortcut is intercepted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;
      if (!isMod) return;
      const k = e.key.toLowerCase();
      if (k === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (k === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  // Auto-dismiss the session-restored banner after a few seconds. It's
  // really only useful as a "hey, this isn't a fresh state" flash — once
  // the user looks away, leaving it up clutters the header.
  useEffect(() => {
    if (!sessionRestored) return;
    const id = window.setTimeout(() => setSessionRestored(false), 5000);
    return () => window.clearTimeout(id);
  }, [sessionRestored]);

  // "New video" wipes the in-memory state AND the persisted session, so the
  // dropzone comes back clean and a future reload doesn't resurrect the
  // discarded project.
  const onNewVideo = useCallback(() => {
    clearVideo();
    setSessionRestored(false);
    void clearSession();
  }, [clearVideo]);

  const onSplitterPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!leftColRef.current) return;
      e.preventDefault();
      setSplitterDragging(true);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);

      const move = (ev: PointerEvent) => {
        if (!leftColRef.current) return;
        const rect = leftColRef.current.getBoundingClientRect();
        const pct = ((ev.clientY - rect.top) / rect.height) * 100;
        setPreviewPct(
          Math.max(PREVIEW_PCT_MIN, Math.min(PREVIEW_PCT_MAX, pct)),
        );
      };
      const up = () => {
        setSplitterDragging(false);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [],
  );

  return (
    <div className="flex h-[100dvh] w-screen flex-col bg-bg">
      {/* Top bar */}
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-bg-elev px-3 py-2 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <div className="text-sm font-semibold text-text">SubIFI</div>
        </div>
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          {(status === 'extracting' ||
            status === 'transcribing' ||
            status === 'burning') && (
            <div className="hidden items-center gap-2 text-xs text-text-muted md:flex">
              <span>
                {status === 'extracting' && 'Extracting audio'}
                {status === 'transcribing' && 'Transcribing'}
                {status === 'burning' && 'Burning MP4'}
              </span>
              <div className="h-1.5 w-36 overflow-hidden rounded-full bg-bg-hi">
                <div
                  className="h-full bg-accent transition-[width] duration-200"
                  style={{ width: `${Math.round(progress * 100)}%` }}
                />
              </div>
            </div>
          )}
          {videoUrl && (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                disabled={!canUndo}
                onClick={undo}
                title="Undo (⌘Z)"
                aria-label="Undo"
              >
                {/* Curved arrow pointing left */}
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M9 14L4 9l5-5" />
                  <path d="M4 9h11a5 5 0 0 1 0 10h-1" />
                </svg>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={!canRedo}
                onClick={redo}
                title="Redo (⇧⌘Z)"
                aria-label="Redo"
              >
                {/* Curved arrow pointing right — mirror of undo */}
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M15 14l5-5-5-5" />
                  <path d="M20 9H9a5 5 0 0 0 0 10h1" />
                </svg>
              </Button>
            </div>
          )}
          {videoUrl && (
            <Button variant="ghost" size="sm" onClick={onNewVideo}>
              <span className="hidden sm:inline">New video</span>
              <span className="sm:hidden">New</span>
            </Button>
          )}
          <FeedbackButton />
          {videoUrl && <ExportMp4Button />}
        </div>
      </header>

      {/* Session-restored banner — shown after a successful auto-rehydrate
          so the user isn't surprised by pre-populated state. Dismissing it
          only hides the banner; the session stays restored. */}
      {sessionRestored && videoUrl && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-emerald-900 bg-emerald-950/40 px-4 py-2 text-xs text-emerald-200">
          <div className="min-w-0 truncate">
            Session restored from your previous tab — work auto-saves as
            you edit.
          </div>
          <button
            type="button"
            className="shrink-0 text-emerald-200 underline hover:text-emerald-100"
            onClick={() => setSessionRestored(false)}
          >
            dismiss
          </button>
        </div>
      )}

      {/* Global error banner — visible even after Dropzone has been replaced */}
      {status === 'error' && error && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-red-900 bg-red-950/40 px-4 py-2 text-sm text-red-200">
          <div className="min-w-0 truncate">
            <span className="font-semibold">Error:</span> {error}
          </div>
          <button
            className="shrink-0 text-xs text-red-200 underline hover:text-red-100"
            onClick={() => setStatus('idle', null)}
          >
            dismiss
          </button>
        </div>
      )}

      {/* Main content */}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* Left / center column — full width on mobile, flex-1 on desktop */}
        <div
          ref={leftColRef}
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          {/* Preview area — splitter controls its height on desktop. On mobile
              we use a clamped vh value so the video keeps a sensible size.
              When a video is loaded we lay out a slim picto sidebar to the
              left of the preview so "add text / add image" stay one click
              away without cluttering the right-hand Style panel. */}
          <div
            // `relative` is the anchor for MediaSidebar's overlay-mode
            // (mobile + landscape video) which absolutely-positions the
            // sidebar inside this container — see components/MediaSidebar.tsx.
            className="relative flex min-h-0 gap-2 p-2 sm:p-3"
            style={
              videoUrl
                ? isDesktop
                  ? { height: `${previewPct}%`, flex: 'none' }
                  : // 40vh on mobile (was 45vh) so the subtitle list /
                    // controls below the video get a bit more room without
                    // shrinking the preview uncomfortably.
                    { height: '40vh', flex: 'none' }
                : { flex: '1 1 0%' }
            }
          >
            {videoUrl ? (
              <>
                <MediaSidebar />
                <div className="min-w-0 flex-1">
                  <VideoPreview />
                </div>
              </>
            ) : (
              <Dropzone />
            )}
          </div>

          {videoUrl && (
            <>
              {/* Draggable splitter — desktop only */}
              <div
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize preview"
                onPointerDown={onSplitterPointerDown}
                onDoubleClick={() => setPreviewPct(PREVIEW_PCT_DEFAULT)}
                className={clsx(
                  'group hidden shrink-0 cursor-row-resize border-y border-border bg-bg-elev transition-colors md:block',
                  splitterDragging ? 'bg-accent/30' : 'hover:bg-bg-hi',
                )}
                style={{ height: 6, touchAction: 'none' }}
                title="Drag to resize — double-click to reset"
              >
                <div className="mx-auto h-full w-10 rounded bg-border group-hover:bg-border-hi" />
              </div>

              {/* Transcribe gate — shown when audio is ready but blocks are empty */}
              <TranscribeButton />

              {/* Presets + Translate + Export bars — tighter vertical rhythm on mobile */}
              <div className="flex shrink-0 flex-col gap-1.5 border-b border-border bg-bg-elev px-3 py-1.5 sm:gap-2 sm:py-2">
                <PresetsBar />
                <TranslateBar />
                <ExportBar />
              </div>

              {/* Mini timeline */}
              <div className="shrink-0 border-b border-border bg-bg-elev px-3 py-1.5 sm:py-2">
                <Timeline />
              </div>

              {/* Mobile tab bar — swaps the panel below between subs and
                  style. Larger touch targets (py-3 = 48px row) on mobile. */}
              <div className="flex shrink-0 items-stretch border-b border-border bg-bg-elev md:hidden">
                <button
                  type="button"
                  onClick={() => setMobileTab('subs')}
                  className={clsx(
                    'flex-1 px-3 py-3 text-sm font-medium',
                    mobileTab === 'subs'
                      ? 'border-b-2 border-accent text-text'
                      : 'text-text-muted',
                  )}
                >
                  Sous-titres
                </button>
                <button
                  type="button"
                  onClick={() => setMobileTab('style')}
                  className={clsx(
                    'flex-1 px-3 py-3 text-sm font-medium',
                    mobileTab === 'style'
                      ? 'border-b-2 border-accent text-text'
                      : 'text-text-muted',
                  )}
                >
                  Style
                </button>
              </div>

              {/* Subtitle list / Style panel content area.
                  - Desktop: always shows the SubtitleList
                  - Mobile: shows either the SubtitleList or the StylePanel
                    depending on the active tab. */}
              <div className="min-h-0 flex-1 bg-bg">
                <div
                  className={clsx(
                    'h-full',
                    mobileTab !== 'subs' && 'hidden md:block',
                  )}
                >
                  <SubtitleList />
                </div>
                <div
                  className={clsx(
                    'h-full md:hidden',
                    mobileTab !== 'style' && 'hidden',
                  )}
                >
                  <StylePanel />
                </div>
              </div>
            </>
          )}
        </div>

        {/* Right column: style panel — desktop only */}
        {videoUrl && (
          <aside className="hidden w-80 shrink-0 border-l border-border bg-bg-elev md:block">
            <StylePanel />
          </aside>
        )}
      </div>

      {/* First-run onboarding overlay. Renders nothing if the user has
          already seen it (localStorage flag) or if the editor isn't ready
          yet. Mounted at the page root so it can spotlight any element. */}
      <OnboardingTour ready={tourReady} />
    </div>
  );
}
