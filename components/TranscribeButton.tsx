'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditor } from '@/lib/store';
import { transcribeAudio } from '@/lib/transcribe';
import { Button } from './ui/button';

// Shown once audio has been extracted. Groq transcription doesn't stream
// job-level progress, so we show wall-clock elapsed time plus a rough
// estimate based on the video duration (Groq whisper-large-v3 processes
// roughly 100× realtime in practice).

const REALTIME_FACTOR = 100;

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function TranscribeButton() {
  const {
    extractedAudio,
    videoDuration,
    status,
    setWords,
    setStatus,
    setProgress,
  } = useEditor();

  const [elapsed, setElapsed] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const startedAtRef = useRef<number | null>(null);

  // Drive the elapsed timer + estimated progress while transcribing.
  useEffect(() => {
    if (status !== 'transcribing') {
      startedAtRef.current = null;
      setElapsed(0);
      return;
    }
    startedAtRef.current = Date.now();
    const id = setInterval(() => {
      if (startedAtRef.current === null) return;
      const ms = Date.now() - startedAtRef.current;
      setElapsed(ms);
      // Estimated progress based on 100× realtime — never reaches 1, tops
      // out at 0.95 so the bar doesn't sit at "done" while Groq is still
      // working.
      if (videoDuration > 0) {
        const estTotalMs = (videoDuration / REALTIME_FACTOR) * 1000;
        const ratio = Math.min(0.95, ms / Math.max(estTotalMs, 1));
        setProgress(ratio);
      }
    }, 200);
    return () => clearInterval(id);
  }, [status, videoDuration, setProgress]);

  const transcribe = useCallback(async () => {
    if (!extractedAudio) return;
    setStatus('transcribing', null);
    setProgress(0);
    try {
      const words = await transcribeAudio(
        extractedAudio,
        videoDuration,
        (done, total) => setProgress(total > 0 ? done / total : 0),
      );
      if (words.length === 0) {
        throw new Error(
          'Groq returned no words (is the clip silent / music-only?)',
        );
      }
      setWords(words);
      setProgress(1);
    } catch (e) {
      console.error('[transcribe] failed', e);
      setStatus('error', e instanceof Error ? e.message : 'Unknown error');
    }
  }, [extractedAudio, videoDuration, setStatus, setProgress, setWords]);

  if (status !== 'audio-ready' && status !== 'transcribing') return null;
  // Banner was dismissed — transcribe is still reachable from the subtitle tab.
  if (dismissed && status === 'audio-ready') return null;

  const estTotalSec =
    videoDuration > 0 ? Math.ceil(videoDuration / REALTIME_FACTOR) : 0;

  return (
    // Stack label + CTA vertically on mobile so the long French button label
    // never clips, and give the CTA full width so it's a proper touch target.
    // Row layout is restored from sm+ where we have horizontal room.
    <div className="relative flex shrink-0 flex-col items-stretch gap-2 border-y border-border bg-bg-elev px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      {status === 'audio-ready' ? (
        <>
          <div className="flex min-w-0 flex-col">
            <div className="text-sm font-medium text-text">
              Audio prêt à transcrire
            </div>
            <div className="text-xs text-text-muted">
              {videoDuration > 0
                ? `~${Math.round(videoDuration)}s de vidéo — estimation ≈ ${estTotalSec}s côté Groq`
                : 'Click to send the audio to Groq whisper-large-v3'}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="md"
              className="w-full shrink-0 sm:w-auto"
              onClick={() => void transcribe()}
            >
              <span className="sm:hidden">Transcrire par IA</span>
              <span className="hidden sm:inline">
                Transcrire automatiquement par IA
              </span>
            </Button>
            <button
              type="button"
              onClick={() => setDismissed(true)}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-muted hover:bg-bg-hi hover:text-text"
              aria-label="Dismiss"
              title="Dismiss transcription banner"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="flex min-w-0 flex-col">
            <div className="text-sm font-medium text-text">
              Transcription en cours…
            </div>
            <div className="text-xs text-text-muted">
              {formatElapsed(elapsed)}
              {estTotalSec > 0 && ` / ~${estTotalSec}s estimé`}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-hi sm:w-40">
              <div
                className="h-full bg-accent transition-[width] duration-200"
                style={{
                  width: `${Math.round(
                    Math.min(
                      0.95,
                      videoDuration > 0
                        ? elapsed / ((videoDuration / REALTIME_FACTOR) * 1000)
                        : elapsed / 60000,
                    ) * 100,
                  )}%`,
                }}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// Compact transcribe button for the subtitle list empty state. Triggers
// the same transcription flow without the full banner.
export function TranscribeInlineButton() {
  const { extractedAudio, status, setWords, setStatus, setProgress, videoDuration } =
    useEditor();

  const transcribe = useCallback(async () => {
    if (!extractedAudio) return;
    setStatus('transcribing', null);
    setProgress(0);
    try {
      const words = await transcribeAudio(
        extractedAudio,
        videoDuration,
        (done, total) => setProgress(total > 0 ? done / total : 0),
      );
      if (words.length === 0) {
        throw new Error(
          'Groq returned no words (is the clip silent / music-only?)',
        );
      }
      setWords(words);
      setProgress(1);
    } catch (e) {
      console.error('[transcribe] failed', e);
      setStatus('error', e instanceof Error ? e.message : 'Unknown error');
    }
  }, [extractedAudio, videoDuration, setStatus, setProgress, setWords]);

  if (status !== 'audio-ready') return null;

  return (
    <Button
      variant="primary"
      size="md"
      onClick={() => void transcribe()}
    >
      Transcrire par IA
    </Button>
  );
}
