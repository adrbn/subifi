import type { SubtitleBlock, Word } from './types';

// Serializers and parsers for subtitle file formats. All pure, no IO.

function pad(n: number, width = 2): string {
  return String(Math.floor(n)).padStart(width, '0');
}

function formatSrtTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds - Math.floor(seconds)) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

function formatVttTimestamp(seconds: number): string {
  // VTT uses a dot instead of comma for milliseconds
  return formatSrtTimestamp(seconds).replace(',', '.');
}

export function toSrt(blocks: SubtitleBlock[]): string {
  return blocks
    .map((b, i) => {
      const start = formatSrtTimestamp(b.start);
      const end = formatSrtTimestamp(b.end);
      return `${i + 1}\n${start} --> ${end}\n${b.text}\n`;
    })
    .join('\n');
}

export function toVtt(blocks: SubtitleBlock[]): string {
  const body = blocks
    .map((b) => {
      const start = formatVttTimestamp(b.start);
      const end = formatVttTimestamp(b.end);
      return `${start} --> ${end}\n${b.text}\n`;
    })
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

// ---------- Parsers (SRT / VTT import) ----------

function parseTimestamp(raw: string): number {
  // Accept "HH:MM:SS,mmm" (SRT) and "HH:MM:SS.mmm" (VTT), also shorthand "MM:SS.mmm".
  const s = raw.trim().replace(',', '.');
  const parts = s.split(':');
  if (parts.length === 3) {
    const [h, m, sec] = parts;
    return Number(h) * 3600 + Number(m) * 60 + Number(sec);
  }
  if (parts.length === 2) {
    const [m, sec] = parts;
    return Number(m) * 60 + Number(sec);
  }
  return Number(s);
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function synthesizeWords(text: string, start: number, end: number): Word[] {
  // Distribute time evenly across words — good enough for manual editing,
  // and lets the segmenter / word-level features keep working after import.
  const toks = text.split(/\s+/).filter(Boolean);
  if (toks.length === 0) return [];
  const dur = Math.max(0.001, end - start);
  const per = dur / toks.length;
  return toks.map((text, i) => ({
    text,
    start: start + i * per,
    end: start + (i + 1) * per,
  }));
}

// Shared cue parser used by SRT and VTT — both are line-oriented formats
// where cues are separated by blank lines and contain a "start --> end" line.
function parseCues(content: string, skipHeader: boolean): SubtitleBlock[] {
  const normalized = content.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  const sections = normalized.split(/\n\s*\n/);
  const start0 = skipHeader ? 1 : 0;
  const blocks: SubtitleBlock[] = [];
  for (let i = start0; i < sections.length; i++) {
    const lines = sections[i].split('\n').filter((l) => l.trim() !== '');
    if (lines.length === 0) continue;
    // Find the timing line (contains "-->").
    const timingIdx = lines.findIndex((l) => l.includes('-->'));
    if (timingIdx === -1) continue;
    const timing = lines[timingIdx];
    const match = timing.match(/(\S+)\s*-->\s*(\S+)/);
    if (!match) continue;
    const start = parseTimestamp(match[1]);
    const end = parseTimestamp(match[2]);
    const textLines = lines.slice(timingIdx + 1);
    const text = textLines.join('\n');
    if (!text) continue;
    blocks.push({
      id: newId(),
      start,
      end,
      text,
      words: synthesizeWords(text.replace(/\n/g, ' '), start, end),
    });
  }
  return blocks;
}

export function fromSrt(content: string): SubtitleBlock[] {
  return parseCues(content, false);
}

export function fromVtt(content: string): SubtitleBlock[] {
  // VTT starts with a "WEBVTT" header block that we skip.
  return parseCues(content, true);
}

// Diagnostic-returning variant. Used by the import UI so a failed parse can
// explain *why* the file was rejected and suggest fixes. The parser itself
// is intentionally lenient — these counters are descriptive, not prescriptive.
export type SubtitleDiagnostic = {
  ok: boolean;
  blocks: SubtitleBlock[];
  totalSections: number;
  validCues: number;
  sectionsMissingTimingLine: number;
  sectionsWithBadTiming: number;
  sectionsWithoutText: number;
  // First problematic section (truncated) — useful to show the user which
  // part of their file we couldn't make sense of.
  firstBadSnippet: string | null;
  // Likely root cause inferred from the counters; null when ok or unknown.
  likelyCause:
    | null
    | 'no-timing-marker'
    | 'unrecognized-time-format'
    | 'empty-file'
    | 'looks-like-something-else';
};

function parseCuesWithDiagnostics(
  content: string,
  skipHeader: boolean,
): SubtitleDiagnostic {
  const normalized = content.replace(/\r\n?/g, '\n').trim();
  if (!normalized) {
    return {
      ok: false,
      blocks: [],
      totalSections: 0,
      validCues: 0,
      sectionsMissingTimingLine: 0,
      sectionsWithBadTiming: 0,
      sectionsWithoutText: 0,
      firstBadSnippet: null,
      likelyCause: 'empty-file',
    };
  }
  const sections = normalized.split(/\n\s*\n/);
  const start0 = skipHeader ? 1 : 0;
  const blocks: SubtitleBlock[] = [];
  let sectionsMissingTimingLine = 0;
  let sectionsWithBadTiming = 0;
  let sectionsWithoutText = 0;
  let firstBadSnippet: string | null = null;
  const recordBad = (snippet: string) => {
    if (firstBadSnippet) return;
    firstBadSnippet = snippet.length > 240 ? snippet.slice(0, 240) + '…' : snippet;
  };
  for (let i = start0; i < sections.length; i++) {
    const raw = sections[i];
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    if (lines.length === 0) continue;
    const timingIdx = lines.findIndex((l) => l.includes('-->'));
    if (timingIdx === -1) {
      sectionsMissingTimingLine++;
      recordBad(raw);
      continue;
    }
    const timing = lines[timingIdx];
    const match = timing.match(/(\S+)\s*-->\s*(\S+)/);
    if (!match) {
      sectionsWithBadTiming++;
      recordBad(raw);
      continue;
    }
    const start = parseTimestamp(match[1]);
    const end = parseTimestamp(match[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      sectionsWithBadTiming++;
      recordBad(raw);
      continue;
    }
    const textLines = lines.slice(timingIdx + 1);
    const text = textLines.join('\n');
    if (!text) {
      sectionsWithoutText++;
      recordBad(raw);
      continue;
    }
    blocks.push({
      id: newId(),
      start,
      end,
      text,
      words: synthesizeWords(text.replace(/\n/g, ' '), start, end),
    });
  }

  const totalSections = sections.length - start0;
  const ok = blocks.length > 0;

  let likelyCause: SubtitleDiagnostic['likelyCause'] = null;
  if (!ok) {
    if (sectionsMissingTimingLine > 0 && sectionsWithBadTiming === 0) {
      // Most sections existed but none had `-->`. Either the user supplied
      // plain text, or the file uses a non-standard separator.
      likelyCause = 'no-timing-marker';
    } else if (sectionsWithBadTiming > 0) {
      likelyCause = 'unrecognized-time-format';
    } else {
      likelyCause = 'looks-like-something-else';
    }
  }

  return {
    ok,
    blocks,
    totalSections,
    validCues: blocks.length,
    sectionsMissingTimingLine,
    sectionsWithBadTiming,
    sectionsWithoutText,
    firstBadSnippet,
    likelyCause,
  };
}

export function fromSrtWithDiagnostics(content: string): SubtitleDiagnostic {
  return parseCuesWithDiagnostics(content, false);
}

export function fromVttWithDiagnostics(content: string): SubtitleDiagnostic {
  return parseCuesWithDiagnostics(content, true);
}

export function toTxt(blocks: SubtitleBlock[]): string {
  return blocks.map((b) => b.text.replace(/\n/g, ' ')).join('\n\n');
}

export function toJson(blocks: SubtitleBlock[]): string {
  return JSON.stringify(
    blocks.map((b) => ({
      id: b.id,
      start: b.start,
      end: b.end,
      text: b.text,
      words: b.words,
    })),
    null,
    2,
  );
}
