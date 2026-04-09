import type { SegmentationConfig, SubtitleBlock, Word } from './types';

// Groups Whisper word-level output into readable subtitle blocks according
// to a segmentation config. Pure function — no side effects. Idempotent:
// re-running on the same words always produces the same blocks.

const SENTENCE_PUNCT = /[.!?…]+$/;
const SOFT_PUNCT = /[,;:]+$/;

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// Greedy word-wrap used by subtitle file exporters (SRT/VTT) that prefer
// explicit line breaks. Never drops words — if the text overflows maxLines
// the remainder is concatenated into the last line.
export function wrapLines(
  text: string,
  maxChars: number,
  maxLines: number,
): string {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= maxChars) {
      current += ' ' + word;
    } else {
      if (lines.length < maxLines - 1) {
        lines.push(current);
        current = word;
      } else {
        // last allowed line — keep appending so we never lose words
        current += ' ' + word;
      }
    }
  }
  if (current) lines.push(current);
  return lines.join('\n');
}

function blockFromWords(cfg: SegmentationConfig, words: Word[]): SubtitleBlock {
  // Wrap into explicit lines at the configured maxCharsPerLine × maxLines.
  // Hard \n breaks are preserved through rendering (DOM preview, ASS, SRT/VTT
  // export) so the user sees the exact layout that will be burned in.
  const raw = words.map((w) => w.text).join(' ');
  const text = wrapLines(raw, cfg.maxCharsPerLine, cfg.maxLines);
  return {
    id: newId(),
    start: words[0].start,
    end: words[words.length - 1].end,
    text,
    words: [...words],
  };
}

export function segmentWords(
  words: Word[],
  cfg: SegmentationConfig,
): SubtitleBlock[] {
  if (words.length === 0) return [];

  const maxChars = cfg.maxCharsPerLine * cfg.maxLines;
  const blocks: SubtitleBlock[] = [];
  let current: Word[] = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length === 0) return;
    blocks.push(blockFromWords(cfg, current));
    current = [];
    currentChars = 0;
  };

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const candidateChars = currentChars + (current.length > 0 ? 1 : 0) + w.text.length;
    const candidateDuration =
      current.length === 0 ? w.end - w.start : w.end - current[0].start;
    const tooManyWords = current.length + 1 > cfg.maxWordsPerBlock;
    const tooLong = candidateChars > maxChars;
    const tooDuration = candidateDuration > cfg.maxDurationSec;

    if (current.length > 0 && (tooLong || tooDuration || tooManyWords)) {
      flush();
    }

    current.push(w);
    currentChars = currentChars + (currentChars > 0 ? 1 : 0) + w.text.length;

    // Break on sentence boundaries if the current block is long enough.
    const isHardBoundary = SENTENCE_PUNCT.test(w.text);
    const isSoftBoundary = SOFT_PUNCT.test(w.text);
    const duration = w.end - current[0].start;
    if (isHardBoundary && duration >= cfg.minDurationSec) {
      flush();
    } else if (
      isSoftBoundary &&
      duration >= cfg.minDurationSec &&
      currentChars >= maxChars * 0.7
    ) {
      flush();
    }
  }

  flush();
  return blocks;
}
