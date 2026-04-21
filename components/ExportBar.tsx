'use client';

import { useRef, useState } from 'react';
import { useEditor } from '@/lib/store';
import { Button } from './ui/button';
import {
  fromSrtWithDiagnostics,
  fromVttWithDiagnostics,
  toJson,
  toSrt,
  toTxt,
  toVtt,
  type SubtitleDiagnostic,
} from '@/lib/subtitle-formats';
import { downloadBlob } from '@/lib/download';
import {
  exportProject,
  parseProjectFile,
  type ProjectFile,
  type ProjectManifest,
} from '@/lib/project-file';
import { computeHeadHash } from '@/lib/video-hash';
import { getVideo, putVideo } from '@/lib/video-cache';
import { captureCoverFrame } from '@/lib/cover-frame';
import { resetFFmpeg } from '@/lib/ffmpeg-client';
import { extractAudio } from '@/lib/audio-extract';
import { ProjectImportModal } from './ProjectImportModal';
import { SrtImportErrorModal } from './SrtImportErrorModal';

// Filename extension probes used by the Import button. Kept case-insensitive
// because downloaded files from different platforms mix casing.
const SRT_EXT = /\.srt$/i;
const VTT_EXT = /\.vtt$/i;
const JSON_EXT = /\.(json|subifi\.json)$/i;

export function ExportBar() {
  const {
    blocks,
    videoFile,
    videoHash,
    videoDuration,
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
    setVideo,
    setVideoHash,
    setExtractedAudio,
    setStatus,
    setProgress,
    setBlocks,
    importProject,
  } = useEditor();

  const baseName = videoFile?.name.replace(/\.[^.]+$/, '') ?? 'subtitles';
  const disabled = blocks.length === 0;
  const projectInputRef = useRef<HTMLInputElement>(null);
  // When a project import comes in without a matching cached video, we
  // stash the parsed project here and pop a modal asking the user to
  // drop the source video file.
  const [pendingProject, setPendingProject] = useState<ProjectFile | null>(null);
  // SRT/VTT import failure state — drives the recovery modal.
  const [srtError, setSrtError] = useState<{
    diagnostic: SubtitleDiagnostic;
    fileName: string;
    originalText: string;
  } | null>(null);

  // Load a File into the editor as if it had been dropped on the Dropzone:
  // probe metadata, set it as the active video, kick off audio extraction,
  // compute head-hash, and cache in IDB. Shared by both the "cache hit"
  // and "user dropped the matching video" paths below.
  const attachVideo = async (file: File, knownHash?: string) => {
    setStatus('extracting', null);
    setProgress(0);
    const url = URL.createObjectURL(file);
    const meta = await new Promise<{ w: number; h: number; d: number } | null>(
      (resolve) => {
        const v = document.createElement('video');
        v.preload = 'metadata';
        v.src = url;
        v.onloadedmetadata = () =>
          resolve({ w: v.videoWidth, h: v.videoHeight, d: v.duration });
        v.onerror = () => resolve(null);
      },
    );
    if (!meta) {
      setStatus('error', 'Could not read video metadata');
      return;
    }
    setVideo(file, url, meta.d, meta.w, meta.h);
    try {
      const hash = knownHash ?? (await computeHeadHash(file));
      setVideoHash(hash);
      // Only re-put when we don't already have it (skip the cache hit case).
      if (!knownHash) await putVideo(hash, file, file.name);
    } catch (e) {
      console.warn('[import] hash/cache failed', e);
    }
    resetFFmpeg();
    try {
      const audio = await extractAudio(file, (r) => setProgress(r));
      setExtractedAudio(audio);
      setStatus('audio-ready', null);
      setProgress(0);
    } catch (e) {
      console.error('[import] extractAudio failed', e);
      setStatus('error', e instanceof Error ? e.message : 'Unknown error');
    }
  };

  // Subtitle-only import: parse an SRT or VTT file and replace the current
  // blocks. Uses the diagnostic parser so we can pop the recovery modal on
  // malformed input instead of silently failing.
  const onImportSubtitles = async (file: File) => {
    const isSrt = SRT_EXT.test(file.name);
    let text: string;
    try {
      text = await file.text();
    } catch (err) {
      setStatus(
        'error',
        err instanceof Error ? err.message : 'Could not read subtitle file',
      );
      return;
    }
    const diagnostic = isSrt
      ? fromSrtWithDiagnostics(text)
      : fromVttWithDiagnostics(text);
    if (!diagnostic.ok) {
      // Stash the failure — the modal renders the diagnostic + recovery UI.
      setSrtError({
        diagnostic,
        fileName: file.name,
        originalText: text,
      });
      return;
    }
    setBlocks(diagnostic.blocks);
    setStatus('ready', null);
  };

  // Router: the Import button accepts BOTH project JSON and subtitle
  // files. Dispatch by extension so each format gets its own parsing and
  // error-recovery path.
  const onImport = async (file: File) => {
    if (SRT_EXT.test(file.name) || VTT_EXT.test(file.name)) {
      await onImportSubtitles(file);
      return;
    }
    // Fall through to project import for JSON (and any other file — the
    // project parser will produce a clear error for non-project JSON).
    await onImportProject(file);
  };

  const onImportProject = async (file: File) => {
    let project: ProjectFile;
    try {
      const json = await file.text();
      project = parseProjectFile(json);
    } catch (err) {
      // Non-JSON or malformed project. If the extension wasn't .json give
      // a more targeted hint than the raw parser message.
      const looksLikeProject = JSON_EXT.test(file.name);
      const base = err instanceof Error ? err.message : 'Invalid file';
      alert(
        looksLikeProject
          ? `Import failed: ${base}`
          : `Import failed: ${base}\n\nTip: the Import button accepts .srt, .vtt, or .subifi.json files.`,
      );
      return;
    }
    // Apply edits/state immediately — the user sees their project come
    // back even while we chase the video file.
    importProject(project);
    // Try to rehydrate the video from IDB by hash. On a hit, re-attach;
    // on a miss, prompt the user for the source file.
    const hash = project.manifest?.headHash ?? null;
    if (hash) {
      const cached = await getVideo(hash);
      if (cached) {
        const rehydrated = new File([cached.blob], cached.name, {
          type: cached.type,
        });
        void attachVideo(rehydrated, hash);
        return;
      }
    }
    // Cache miss (or v1 file without manifest). Show the modal so the
    // user can drop the matching source video — we'll soft-warn on
    // hash mismatch but still accept the file.
    setPendingProject(project);
  };

  const onPendingVideoPicked = async (file: File) => {
    const project = pendingProject;
    setPendingProject(null);
    if (!project) return;
    const expected = project.manifest?.headHash ?? null;
    if (expected) {
      try {
        const actual = await computeHeadHash(file);
        if (actual !== expected) {
          // Soft-warn: the file doesn't match what the project was
          // exported against. Timing/subtitle positions may look off,
          // but the user still gets a working editor so they can fix up.
          alert(
            `Heads up: the video you picked does not match the one this project was exported from. ` +
              `Subtitles and overlays are timed against the original source — some cues may not line up perfectly.`,
          );
        }
        await attachVideo(file, actual);
        return;
      } catch {
        // fall through to attach without a known hash
      }
    }
    await attachVideo(file);
  };

  const onExportProject = async () => {
    // Build the manifest. If the user dropped a video we have everything;
    // otherwise `videoFile` is null and we export without a manifest so
    // v1-style round-tripping still works.
    let manifest: ProjectManifest = null;
    if (videoFile) {
      try {
        const hash = videoHash ?? (await computeHeadHash(videoFile));
        if (!videoHash) setVideoHash(hash);
        const cover = await captureCoverFrame(videoFile);
        manifest = {
          name: videoFile.name,
          size: videoFile.size,
          type: videoFile.type || 'video/mp4',
          duration: videoDuration,
          headHash: hash,
          coverDataUrl: cover,
        };
        // Make sure the cache has the current video, even if the user
        // skipped the initial put (e.g. opened an older session).
        await putVideo(hash, videoFile, videoFile.name).catch(() => {
          /* non-fatal */
        });
      } catch (e) {
        console.warn('[export] manifest build failed', e);
      }
    }
    const json = exportProject({
      style,
      segmentation,
      blocks,
      subtitleTracks,
      activeTrackId,
      words,
      textOverlays,
      overlays,
      cuts,
      safeZone,
      customFonts,
      manifest,
    });
    downloadBlob(json, `${baseName}.subifi.json`, 'application/json');
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
      {/* Divider separates subtitle-format exports (SRT/VTT/TXT/JSON) from
          project-level actions (full project save & reimport). */}
      <span
        className="mx-1 h-5 w-px shrink-0 bg-border"
        aria-hidden="true"
      />
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled}
        className="shrink-0"
        onClick={() => void onExportProject()}
      >
        Project
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0"
        onClick={() => projectInputRef.current?.click()}
        title="Import .srt, .vtt, or a .subifi.json project"
      >
        Import
      </Button>
      <input
        ref={projectInputRef}
        type="file"
        // Accept subtitle formats alongside project JSON so the single
        // Import button works whether the user is bringing in cues from
        // an external tool (SRT/VTT) or restoring a full SubIFI project.
        accept=".srt,.vtt,text/vtt,.json,.subifi.json,application/json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onImport(file);
          e.target.value = '';
        }}
      />
      <ProjectImportModal
        project={pendingProject}
        onPick={(f) => void onPendingVideoPicked(f)}
        onClose={() => setPendingProject(null)}
      />
      {srtError && (
        <SrtImportErrorModal
          diagnostic={srtError.diagnostic}
          fileName={srtError.fileName}
          originalText={srtError.originalText}
          onClose={() => setSrtError(null)}
        />
      )}
    </div>
  );
}
