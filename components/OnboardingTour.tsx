'use client';

import { useEffect, useLayoutEffect, useState } from 'react';

// First-run guided tour. Highlights the main areas of the editor right
// after the user has loaded a video AND we have something to show (i.e.
// subtitle blocks have been generated). Targets are looked up by
// `data-tour="..."` attributes on the actual elements, so we don't need
// to thread refs through every component.
//
// The tour is intentionally lightweight: a translucent backdrop with an
// SVG "hole" cut around the current target, plus a small tooltip card
// pinned next to it. Step-by-step Next/Prev/Skip controls. Persists a
// "done" flag in localStorage so it only runs once per browser.

const STORAGE_KEY = 'subifi:tour-done-v1';

type Step = {
  selector: string;
  title: string;
  body: string;
  // Where to anchor the tooltip relative to the target. We auto-flip if
  // the chosen side runs off the viewport.
  placement?: 'top' | 'bottom' | 'left' | 'right';
};

const STEPS: Step[] = [
  {
    selector: '[data-tour="preview"]',
    title: 'Preview',
    body: 'Your video with all overlays. Drag the subtitle to reposition · scroll to resize · double-click to edit text in place. The corner button enters fullscreen WITH the overlays.',
    placement: 'bottom',
  },
  {
    selector: '[data-tour="media-sidebar"]',
    title: 'Add media',
    body: 'Quick adds: T for a free-form text overlay, image icon for logos / stickers / watermarks. Drag them on the preview to position.',
    placement: 'right',
  },
  {
    selector: '[data-tour="presets"]',
    title: 'Presets',
    body: 'One-click style presets (TikTok, Karaoke, News…) and segmentation modes (Cinéma, TikTok, 1 mot). Save your own once you tune a look.',
    placement: 'top',
  },
  {
    selector: '[data-tour="timeline"]',
    title: 'Timeline',
    body: 'Click to scrub. Drag a clip to slide it (it snaps to neighbors), drag an edge to trim. Add free text or cuts from the buttons. Click a subtitle to focus it everywhere.',
    placement: 'top',
  },
  {
    selector: '[data-tour="style-panel"]',
    title: 'Style panel',
    body: 'Every style knob (font, colors, outline, position, dead zones, image / text overlays). Mobile users get this as a bottom tab.',
    placement: 'left',
  },
  {
    selector: '[data-tour="export"]',
    title: 'Export',
    body: 'Burn the styled subtitles into a fresh MP4. Cuts get stitched out automatically. The progress bar in the header tracks the encode.',
    placement: 'bottom',
  },
];

type Rect = { top: number; left: number; width: number; height: number };

function getRect(selector: string): Rect | null {
  if (typeof document === 'undefined') return null;
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = (el as HTMLElement).getBoundingClientRect();
  return {
    top: r.top,
    left: r.left,
    width: r.width,
    height: r.height,
  };
}

export function OnboardingTour({ ready }: { ready: boolean }) {
  const [active, setActive] = useState(false);
  const [stepIdx, setStepIdx] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });

  // Decide whether to start the tour. We only run it once per browser
  // and only after the editor is fully populated (video loaded AND
  // subtitles generated), so the highlighted areas actually exist.
  useEffect(() => {
    // IMPORTANT: if readiness drops (e.g. the user clicked "New video"),
    // we MUST tear the tour down. Without this, the fixed inset-0
    // overlay stayed pinned and invisibly ate every click on the
    // Dropzone / header buttons — the element was still there, just
    // with no spotlight rect because the data-tour targets no longer
    // exist. Reset both active and the step so a fresh video starts
    // from step one.
    if (!ready) {
      setActive(false);
      setStepIdx(0);
      return;
    }
    try {
      if (localStorage.getItem(STORAGE_KEY) === '1') return;
    } catch {
      // localStorage blocked — still show the tour, just don't persist.
    }
    // Tiny delay so the layout settles before we measure target rects.
    const id = window.setTimeout(() => setActive(true), 350);
    return () => window.clearTimeout(id);
  }, [ready]);

  // Measure the current step's target on every step change AND on
  // viewport resize / scroll, so the spotlight follows reflows.
  useLayoutEffect(() => {
    if (!active) return;
    const measure = () => {
      setViewport({ w: window.innerWidth, h: window.innerHeight });
      const r = getRect(STEPS[stepIdx].selector);
      setRect(r);
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [active, stepIdx]);

  // Allow ESC to skip the tour, and arrow keys to advance / go back.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
      else if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') prev();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, stepIdx]);

  // Double gate — we reset `active` when `ready` drops, but the render
  // guard is the last line of defense against a stale overlay swallowing
  // clicks when the Dropzone is on screen.
  if (!active || !ready) return null;

  const step = STEPS[stepIdx];

  const finish = () => {
    setActive(false);
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // ignore
    }
  };

  const next = () => {
    if (stepIdx < STEPS.length - 1) setStepIdx((i) => i + 1);
    else finish();
  };

  const prev = () => {
    if (stepIdx > 0) setStepIdx((i) => i - 1);
  };

  // Tooltip dimensions are fixed-ish (max-width). We compute the anchor
  // position from the target rect + chosen placement, then auto-flip if
  // the chosen side would push the card off-screen.
  const TIP_W = 320;
  const TIP_H = 160;
  const PAD = 14;

  let tipTop = viewport.h / 2 - TIP_H / 2;
  let tipLeft = viewport.w / 2 - TIP_W / 2;

  if (rect) {
    // Default placement based on the step's hint, with auto-flip rules.
    let placement = step.placement ?? 'bottom';
    if (placement === 'bottom' && rect.top + rect.height + PAD + TIP_H > viewport.h)
      placement = 'top';
    if (placement === 'top' && rect.top - PAD - TIP_H < 0) placement = 'bottom';
    if (placement === 'right' && rect.left + rect.width + PAD + TIP_W > viewport.w)
      placement = 'left';
    if (placement === 'left' && rect.left - PAD - TIP_W < 0) placement = 'right';

    if (placement === 'bottom') {
      tipTop = rect.top + rect.height + PAD;
      tipLeft = rect.left + rect.width / 2 - TIP_W / 2;
    } else if (placement === 'top') {
      tipTop = rect.top - PAD - TIP_H;
      tipLeft = rect.left + rect.width / 2 - TIP_W / 2;
    } else if (placement === 'right') {
      tipTop = rect.top + rect.height / 2 - TIP_H / 2;
      tipLeft = rect.left + rect.width + PAD;
    } else {
      tipTop = rect.top + rect.height / 2 - TIP_H / 2;
      tipLeft = rect.left - PAD - TIP_W;
    }
    // Clamp to viewport so the card never escapes the screen.
    tipTop = Math.max(8, Math.min(viewport.h - TIP_H - 8, tipTop));
    tipLeft = Math.max(8, Math.min(viewport.w - TIP_W - 8, tipLeft));
  }

  return (
    <div
      className="fixed inset-0 z-[60]"
      // The backdrop is interactive so a click anywhere outside the
      // current target advances to the next step (common tour UX).
      onClick={next}
    >
      {/* SVG backdrop with a "hole" cut around the target rect — gives a
          spotlight effect without resorting to a 4-div clipping hack. */}
      <svg
        className="pointer-events-none absolute inset-0 h-full w-full"
        width={viewport.w}
        height={viewport.h}
      >
        <defs>
          <mask id="subifi-tour-mask">
            <rect width="100%" height="100%" fill="white" />
            {rect && (
              <rect
                x={rect.left - 6}
                y={rect.top - 6}
                width={rect.width + 12}
                height={rect.height + 12}
                rx={10}
                ry={10}
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect
          width="100%"
          height="100%"
          fill="rgba(0,0,0,0.62)"
          mask="url(#subifi-tour-mask)"
        />
        {rect && (
          <rect
            x={rect.left - 6}
            y={rect.top - 6}
            width={rect.width + 12}
            height={rect.height + 12}
            rx={10}
            ry={10}
            fill="none"
            stroke="rgba(96,165,250,0.9)"
            strokeWidth={2}
          />
        )}
      </svg>

      {/* Tooltip card */}
      <div
        className="absolute rounded-lg border border-border bg-bg-elev p-4 text-sm shadow-2xl"
        style={{
          top: tipTop,
          left: tipLeft,
          width: TIP_W,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <div className="text-xs font-semibold uppercase tracking-wider text-accent">
            {step.title}
          </div>
          <div className="text-[10px] text-text-muted">
            {stepIdx + 1} / {STEPS.length}
          </div>
        </div>
        <div className="mb-3 text-xs leading-relaxed text-text">{step.body}</div>
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={finish}
            className="text-[11px] text-text-muted underline hover:text-text"
          >
            Skip tour
          </button>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={prev}
              disabled={stepIdx === 0}
              className="rounded border border-border px-2 py-1 text-[11px] text-text-muted hover:border-accent hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
            >
              Back
            </button>
            <button
              type="button"
              onClick={next}
              className="rounded bg-accent px-3 py-1 text-[11px] font-medium text-bg hover:bg-accent/90"
            >
              {stepIdx === STEPS.length - 1 ? 'Got it' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
