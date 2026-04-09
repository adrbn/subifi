'use client';

import { useEditor } from '@/lib/store';
import { SEGMENTATION_PRESETS, STYLE_PRESETS } from '@/lib/presets';
import { Button } from './ui/button';

export function PresetsBar() {
  const { applyStylePreset, resegment } = useEditor();

  return (
    // On mobile: a single horizontally scrollable strip so the labels +
    // buttons never wrap onto multiple cramped lines. The section labels are
    // hidden on mobile because the button labels themselves are already
    // self-explanatory (Cinéma/TikTok/Minimal/News) and the horizontal
    // scroll strip is tighter without them. On sm+ we restore labels and
    // allow wrapping as before.
    <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 sm:mx-0 sm:flex-wrap sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <span className="shrink-0 text-xs uppercase tracking-wider text-text-muted">
        <span className="sm:hidden">Style</span>
        <span className="hidden sm:inline">Style preset</span>
      </span>
      {STYLE_PRESETS.map((p) => (
        <Button
          key={p.id}
          variant="secondary"
          size="sm"
          className="shrink-0"
          onClick={() => applyStylePreset(p.style)}
        >
          {p.label}
        </Button>
      ))}
      <span className="mx-1 hidden h-4 w-px shrink-0 bg-border sm:inline-block" />
      <span className="shrink-0 text-xs uppercase tracking-wider text-text-muted">
        <span className="sm:hidden">Coupe</span>
        <span className="hidden sm:inline">Segmentation</span>
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
    </div>
  );
}
