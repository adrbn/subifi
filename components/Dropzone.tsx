'use client';

import { useCallback, useRef, useState } from 'react';
import clsx from 'clsx';
import { useEditor } from '@/lib/store';
import { extractAudio } from '@/lib/audio-extract';
import { fromSrt, fromVtt } from '@/lib/subtitle-formats';

// The Dropzone handles three kinds of drops:
//   1. A video file — probe metadata, extract audio, then stop. The user
//      triggers transcription explicitly via the TranscribeButton so Groq
//      isn't billed for every accidental drop.
//   2. An SRT or VTT subtitle file — parse and load directly into the
//      editor, no transcription round-trip. A video can be dropped later
//      to pair with the imported cues.
//   3. Anything else — error.

const VIDEO_EXT = /\.(mp4|mov|mkv|webm|avi|m4v|ogv)$/i;
const SRT_EXT = /\.srt$/i;
const VTT_EXT = /\.vtt$/i;

function isVideoFile(file: File): boolean {
  return file.type.startsWith('video/') || VIDEO_EXT.test(file.name);
}
function isSrtFile(file: File): boolean {
  return SRT_EXT.test(file.name);
}
function isVttFile(file: File): boolean {
  return VTT_EXT.test(file.name) || file.type === 'text/vtt';
}

export function Dropzone() {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const {
    setVideo,
    setExtractedAudio,
    setBlocks,
    setStatus,
    setProgress,
    status,
    error,
  } = useEditor();

  const handleFile = useCallback(
    async (file: File) => {
      // Subtitle file import — goes straight to blocks, no transcription.
      if (isSrtFile(file) || isVttFile(file)) {
        try {
          const text = await file.text();
          const parsed = isSrtFile(file) ? fromSrt(text) : fromVtt(text);
          if (parsed.length === 0) {
            setStatus('error', 'Subtitle file had no cues we could parse.');
            return;
          }
          setBlocks(parsed);
          setStatus('ready', null);
        } catch (e) {
          setStatus(
            'error',
            e instanceof Error ? e.message : 'Could not read subtitle file',
          );
        }
        return;
      }

      if (!isVideoFile(file)) {
        setStatus('error', 'Not a video or subtitle file');
        return;
      }
      setStatus('extracting', null);
      setProgress(0);

      // Probe via a hidden <video> to get dimensions + duration.
      const url = URL.createObjectURL(file);
      const meta = await new Promise<{ w: number; h: number; d: number }>(
        (resolve, reject) => {
          const v = document.createElement('video');
          v.preload = 'metadata';
          v.src = url;
          v.onloadedmetadata = () =>
            resolve({ w: v.videoWidth, h: v.videoHeight, d: v.duration });
          v.onerror = () => reject(new Error('Could not read video metadata'));
        },
      ).catch((e) => {
        setStatus('error', e.message);
        return null;
      });
      if (!meta) return;

      setVideo(file, url, meta.d, meta.w, meta.h);

      try {
        const audio = await extractAudio(file, (r) => setProgress(r));
        setExtractedAudio(audio);
        // Stop here — the user has to click "Transcrire automatiquement".
        setStatus('audio-ready', null);
        setProgress(0);
      } catch (e) {
        console.error('[dropzone] extractAudio failed', e);
        setStatus('error', e instanceof Error ? e.message : 'Unknown error');
      }
    },
    [setVideo, setExtractedAudio, setBlocks, setStatus, setProgress],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) void handleFile(file);
    },
    [handleFile],
  );

  return (
    <div
      onDragEnter={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      onClick={() => inputRef.current?.click()}
      className={clsx(
        'flex h-full w-full cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-6 text-center transition-colors',
        dragging
          ? 'border-accent bg-accent/5'
          : 'border-border hover:border-border-hi hover:bg-bg-hi',
      )}
    >
      <div className="text-2xl">🎬</div>
      <div className="text-sm font-semibold text-text">
        Drop a video or .srt / .vtt
      </div>
      <div className="text-xs text-text-muted">
        Click to browse — MP4, MOV, MKV, WebM
      </div>
      {status !== 'idle' && status !== 'ready' && status !== 'audio-ready' && (
        <div className="mt-3 text-sm text-accent">
          {status === 'extracting' && 'Extracting audio…'}
          {status === 'transcribing' && 'Transcribing with Groq…'}
          {status === 'burning' && 'Burning subtitles…'}
        </div>
      )}
      {error && <div className="mt-2 text-sm text-red-400">{error}</div>}
      <input
        ref={inputRef}
        type="file"
        accept="video/*,.srt,.vtt,text/vtt"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleFile(file);
        }}
      />
    </div>
  );
}
