// IndexedDB-backed session persistence. The editor state contains File,
// Uint8Array, and ArrayBuffer instances that can't go through localStorage
// (both because of the ~5MB quota and because JSON.stringify destroys
// binary data), so we use IDB's structured-clone storage directly: File,
// Uint8Array, and ArrayBuffer all round-trip natively via structured clone.
//
// Persistence is best-effort — any failure (quota, private mode, blocked
// storage) is silently swallowed. Users still have a working editor, they
// just don't get the auto-resume on reload.

import type {
  CustomFont,
  ImageOverlay,
  SafeZone,
  SegmentationConfig,
  Style,
  SubtitleBlock,
  Word,
} from './types';

const DB_NAME = 'subifi';
const DB_VERSION = 1;
const STORE = 'session';
const KEY = 'current';

// Bump this if we ever make a breaking change to SessionSnapshot — old
// snapshots with a different version are ignored on load.
const SNAPSHOT_VERSION = 1 as const;

export type SessionSnapshot = {
  version: typeof SNAPSHOT_VERSION;
  savedAt: number;
  // Video — File is stored as-is; IDB uses structured clone and will
  // serialize the bytes eagerly so the restored File keeps working even if
  // the original file on disk goes away.
  videoFile: File | null;
  videoDuration: number;
  videoWidth: number;
  videoHeight: number;
  // Audio — the raw bytes extracted by ffmpeg, so the user can retry
  // transcription without re-running the extract pass.
  extractedAudio: Uint8Array | null;
  // Transcription + segmentation output
  words: Word[];
  blocks: SubtitleBlock[];
  // Styling
  style: Style;
  segmentation: SegmentationConfig;
  customFonts: CustomFont[];
  overlays: ImageOverlay[];
  selectedOverlayId: string | null;
  safeZone: SafeZone;
};

function isIdbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadSession(): Promise<SessionSnapshot | null> {
  if (!isIdbAvailable()) return null;
  try {
    const db = await openDb();
    const result = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (!result || typeof result !== 'object') return null;
    const snapshot = result as SessionSnapshot;
    if (snapshot.version !== SNAPSHOT_VERSION) return null;
    return snapshot;
  } catch {
    return null;
  }
}

export async function saveSession(snapshot: SessionSnapshot): Promise<void> {
  if (!isIdbAvailable()) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(snapshot, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Best-effort — the user's work is still in memory either way.
  }
}

export async function clearSession(): Promise<void> {
  if (!isIdbAvailable()) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  } catch {
    // ignore
  }
}
