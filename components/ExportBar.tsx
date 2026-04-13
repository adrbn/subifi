'use client';

import { useRef } from 'react';
import { useEditor } from '@/lib/store';
import { Button } from './ui/button';
import { toJson, toSrt, toTxt, toVtt } from '@/lib/subtitle-formats';
import { downloadBlob } from '@/lib/download';
import { exportProject, parseProjectFile } from '@/lib/project-file';

export function ExportBar() {
  const {
    blocks,
    videoFile,
    style,
    segmentation,
    subtitleTracks,
    activeTrackId,
    words,
    textOverlays,
    overlays,
    cuts,
    safeZone,
    customFonts,
    importProject,
  } = useEditor();

  const baseName = videoFile?.name.replace(/\.[^.]+$/, '') ?? 'subtitles';
  const disabled = blocks.length === 0;
  const projectInputRef = useRef<HTMLInputElement>(null);

  const onImportProject = async (file: File) => {
    try {
      const json = await file.text();
      const project = parseProjectFile(json);
      importProject(project);
    } catch (err) {
      alert(`Import failed: ${err instanceof Error ? err.message : 'Invalid file'}`);
    }
  };

  return (
    // Same treatment as PresetsBar: horizontally scrollable on mobile, wraps
    // on sm+. Label is mobile-hidden because SRT/VTT/TXT/JSON are already
    // self-describing.
    <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 sm:mx-0 sm:flex-wrap sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <span className="w-20 shrink-0 text-xs uppercase tracking-wider text-text-muted">
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
      <Button
        variant="secondary"
        size="sm"
        disabled={disabled}
        className="shrink-0"
        onClick={() => {
          const json = exportProject({
            style, segmentation, blocks, subtitleTracks, activeTrackId,
            words, textOverlays, overlays, cuts, safeZone, customFonts,
          });
          downloadBlob(json, `${baseName}.subifi.json`, 'application/json');
        }}
      >
        Project
      </Button>
      <Button
        variant="secondary"
        size="sm"
        className="shrink-0"
        onClick={() => projectInputRef.current?.click()}
      >
        Import
      </Button>
      <input
        ref={projectInputRef}
        type="file"
        accept=".json,.subifi.json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onImportProject(file);
          e.target.value = '';
        }}
      />
    </div>
  );
}
