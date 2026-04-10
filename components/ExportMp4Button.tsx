'use client';

import { useState } from 'react';
import { useEditor } from '@/lib/store';
import { burnSubtitles, cancelBurn, BurnCancelledError } from '@/lib/burn-in';
import { downloadBlob } from '@/lib/download';

// Primary CTA mounted in the top-right of the header. Kicks off the ffmpeg
// burn pipeline with the current style + overlays and triggers a download
// when done. Disabled until there are blocks to burn.

export function ExportMp4Button() {
  const {
    videoFile,
    videoDuration,
    videoWidth,
    videoHeight,
    style,
    customFonts,
    overlays,
    imageOverlaysVisible,
    textOverlays,
    textOverlaysVisible,
    cuts,
    cutsVisible,
    setStatus,
    setProgress,
    status,
    visibleBlocks,
    blocks,
  } = useEditor();
  const [burnProgress, setBurnProgress] = useState(0);

  const baseName = videoFile?.name.replace(/\.[^.]+$/, '') ?? 'video';
  const hasAnyContent =
    blocks.length > 0 || overlays.length > 0 || textOverlays.length > 0;
  const disabled = !videoFile || !hasAnyContent || status === 'burning';

  const onClick = async () => {
    if (!videoFile) return;
    setStatus('burning', null);
    setProgress(0);
    setBurnProgress(0);
    try {
      const burnBlocks = visibleBlocks();
      const burnOverlays = imageOverlaysVisible ? overlays : [];
      const burnTextOverlays = textOverlaysVisible ? textOverlays : [];
      const burnCuts = cutsVisible ? cuts : [];
      const out = await burnSubtitles(
        {
          videoFile,
          blocks: burnBlocks,
          style,
          videoWidth,
          videoHeight,
          customFonts,
          overlays: burnOverlays,
          textOverlays: burnTextOverlays,
          cuts: burnCuts,
          videoDuration,
        },
        (p) => {
          setProgress(p);
          setBurnProgress(p);
        },
      );
      downloadBlob(out, `${baseName}-subbed.mp4`, 'video/mp4');
      setStatus('ready', null);
    } catch (e) {
      // Cancellations are user-initiated — no error banner, just go back
      // to "ready" so the button reverts and they can try again.
      if (e instanceof BurnCancelledError) {
        setStatus('ready', null);
        setProgress(0);
        setBurnProgress(0);
        return;
      }
      setStatus('error', e instanceof Error ? e.message : 'Burn failed');
    }
  };

  const isBurning = status === 'burning';

  if (isBurning) {
    return (
      <button
        type="button"
        onClick={() => cancelBurn()}
        className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-red-500"
        title="Stop the in-progress export"
      >
        <span>■</span>
        <span>Cancel · {Math.round(burnProgress * 100)}%</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      data-tour="export"
      onClick={() => void onClick()}
      disabled={disabled}
      className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-emerald-900/60 disabled:text-emerald-300/50"
      title={
        disabled && !hasAnyContent
          ? 'Add subtitles, text, or images first'
          : 'Burn subtitles + overlays into an MP4'
      }
    >
      <span>▶</span>
      <span>Export</span>
    </button>
  );
}
