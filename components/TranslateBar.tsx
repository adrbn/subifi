'use client';

import { useState } from 'react';
import { useEditor } from '@/lib/store';
import { Button } from './ui/button';
import { Select } from './ui/select';

// One-shot translator: takes every block's text, sends them to /api/translate
// in batches, then writes the results back through `updateBlock`. Each
// `updateBlock` call goes through the store's history pipeline so the user
// can revert the entire translation with Cmd+Z (the 350ms coalescing window
// folds the rapid-fire updates into a single undo step).

const LANGUAGES: { code: string; label: string }[] = [
  { code: 'English', label: 'English' },
  { code: 'French', label: 'Français' },
  { code: 'Spanish', label: 'Español' },
  { code: 'German', label: 'Deutsch' },
  { code: 'Italian', label: 'Italiano' },
  { code: 'Portuguese', label: 'Português' },
  { code: 'Japanese', label: '日本語' },
  { code: 'Korean', label: '한국어' },
  { code: 'Chinese', label: '中文' },
  { code: 'Arabic', label: 'العربية' },
  { code: 'Hindi', label: 'हिन्दी' },
  { code: 'Russian', label: 'Русский' },
];

// Match the server-side cap (MAX_TEXTS_PER_REQUEST) so a long transcription
// is split into multiple round-trips.
const BATCH_SIZE = 100;

type TranslateApiResponse =
  | { translations: string[] }
  | { error: string };

export function TranslateBar() {
  const { blocks, addSubtitleTrack, setActiveTrack } = useEditor();
  const [target, setTarget] = useState<string>('English');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const disabled = blocks.length === 0 || busy;

  const onTranslate = async () => {
    if (blocks.length === 0) return;
    setBusy(true);
    setError(null);

    try {
      // Translate all blocks batch-by-batch, collecting the results.
      const translated: string[] = [];
      for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
        const batch = blocks.slice(i, i + BATCH_SIZE);
        const res = await fetch('/api/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            texts: batch.map((b) => b.text),
            targetLang: target,
          }),
        });
        const json = (await res.json()) as TranslateApiResponse;
        if (!res.ok || 'error' in json) {
          const msg =
            'error' in json ? json.error : `Translation failed (${res.status})`;
          throw new Error(msg);
        }
        translated.push(...json.translations);
      }
      // Create translated blocks: same timings, new text, fresh ids.
      const translatedBlocks = blocks.map((b, i) => ({
        ...b,
        id: Math.random().toString(36).slice(2, 10),
        text: translated[i]?.trim() || b.text,
        words: undefined, // word-level timings don't apply to translation
      }));
      // Find the language label for display.
      const langLabel =
        LANGUAGES.find((l) => l.code === target)?.label ?? target;
      const trackId = addSubtitleTrack(langLabel, translatedBlocks);
      setActiveTrack(trackId);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Translation failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
      <span className="w-20 shrink-0 text-xs uppercase tracking-wider text-text-muted">
        Traduire
      </span>
      <Select
        className="h-8 min-w-0 flex-1 sm:w-32 sm:flex-none"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        disabled={busy}
      >
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </Select>
      <Button
        variant="secondary"
        size="sm"
        disabled={disabled}
        className="shrink-0"
        onClick={onTranslate}
        title={
          blocks.length === 0
            ? 'Transcribe first to get something to translate'
            : `Translate ${blocks.length} blocks to ${target}`
        }
      >
        {busy ? '…' : 'Go'}
      </Button>
      {error && (
        <span className="w-full truncate text-xs text-red-300" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}
