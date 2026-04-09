'use client';

import { useEditor } from '@/lib/store';
import { Button } from './ui/button';
import { toJson, toSrt, toTxt, toVtt } from '@/lib/subtitle-formats';
import { downloadBlob } from '@/lib/download';

export function ExportBar() {
  const { blocks, videoFile } = useEditor();

  const baseName = videoFile?.name.replace(/\.[^.]+$/, '') ?? 'subtitles';
  const disabled = blocks.length === 0;

  return (
    // Same treatment as PresetsBar: horizontally scrollable on mobile, wraps
    // on sm+. Label is mobile-hidden because SRT/VTT/TXT/JSON are already
    // self-describing.
    <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 sm:mx-0 sm:flex-wrap sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <span className="shrink-0 text-xs uppercase tracking-wider text-text-muted">
        Export
      </span>
      <Button
        variant="secondary"
        size="sm"
        disabled={disabled}
        className="shrink-0"
        onClick={() => downloadBlob(toSrt(blocks), `${baseName}.srt`, 'text/plain')}
      >
        SRT
      </Button>
      <Button
        variant="secondary"
        size="sm"
        disabled={disabled}
        className="shrink-0"
        onClick={() => downloadBlob(toVtt(blocks), `${baseName}.vtt`, 'text/vtt')}
      >
        VTT
      </Button>
      <Button
        variant="secondary"
        size="sm"
        disabled={disabled}
        className="shrink-0"
        onClick={() => downloadBlob(toTxt(blocks), `${baseName}.txt`, 'text/plain')}
      >
        TXT
      </Button>
      <Button
        variant="secondary"
        size="sm"
        disabled={disabled}
        className="shrink-0"
        onClick={() =>
          downloadBlob(toJson(blocks), `${baseName}.json`, 'application/json')
        }
      >
        JSON
      </Button>
    </div>
  );
}
