'use client';

import { useState } from 'react';
import { useEditor } from '@/lib/store';
import { burnSubtitles } from '@/lib/burn-in';
import { downloadBlob } from '@/lib/download';

// Primary CTA mounted in the top-right of the header. Kicks off the ffmpeg
// burn pipeline with the current style + overlays and triggers a download
// when done. Disabled until there are blocks to burn.

export function ExportMp4Button() {
  const {
    blocks,
    videoFile,
    videoWidth,
    videoHeight,
    style,
    customFonts,
    overlays,
    setStatus,
    setProgress,
    status,
  } = useEditor();
  const [burnProgress, setBurnProgress] = useState(0);

  const baseName = videoFile?.name.replace(/\.[^.]+$/, '') ?? 'video';
  const disabled = !videoFile || blocks.length === 0 || status === 'burning';

  const onClick = async () => {
    if (!videoFile) return;
    setStatus('burning', null);
    setProgress(0);
    setBurnProgress(0);
    try {
      const out = await burnSubtitles(
        {
          videoFile,
          blocks,
          style,
          videoWidth,
          videoHeight,
          customFonts,
          overlays,
        },
        (p) => {
          setProgress(p);
          setBurnProgress(p);
        },
      );
      downloadBlob(out, `${baseName}-subbed.mp4`, 'video/mp4');
      setStatus('ready', null);
    } catch (e) {
      setStatus('error', e instanceof Error ? e.message : 'Burn failed');
    }
  };

  const label =
    status === 'burning'
      ? `Exporting… ${Math.round(burnProgress * 100)}%`
      : 'Export MP4';

  return (
    <button
      type="button"
      onClick={() => void onClick()}
      disabled={disabled}
      className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-emerald-900/60 disabled:text-emerald-300/50"
      title={
        disabled && blocks.length === 0
          ? 'Load a video and generate subtitles first'
          : 'Burn subtitles + overlays into an MP4'
      }
    >
      <span>▶</span>
      <span>{label}</span>
    </button>
  );
}
