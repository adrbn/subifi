// Content-addressable identifier for a video file. We hash only the first
// 64KB because full-file hashing a multi-GB clip on the main thread takes
// seconds and stalls the UI — the head of an MP4/MKV/WEBM contains the
// container header + moov/ebml metadata, which is more than enough to
// distinguish different files in practice. We also fold the byte size in
// so two clips that happen to share a head (rare, but possible for edited
// versions of the same source) still produce distinct hashes.
//
// The output is a lowercase hex SHA-256 string prefixed with "h1:" so we
// can later ship a different algorithm (e.g. xxh128 via WASM) without
// invalidating old manifests.
//
// Non-goal: cryptographic integrity. This hash exists to recognize a file
// you already have, not to prove it hasn't been tampered with.
const HEAD_BYTES = 64 * 1024;

export async function computeHeadHash(file: File | Blob): Promise<string> {
  const head = await file.slice(0, HEAD_BYTES).arrayBuffer();
  // Concatenate head + 8 bytes of little-endian size so size collisions are
  // impossible to fake via a tail-only edit.
  const sizeBuf = new ArrayBuffer(8);
  new DataView(sizeBuf).setBigUint64(0, BigInt(file.size), true);
  const merged = new Uint8Array(head.byteLength + 8);
  merged.set(new Uint8Array(head), 0);
  merged.set(new Uint8Array(sizeBuf), head.byteLength);
  const digest = await crypto.subtle.digest('SHA-256', merged);
  return `h1:${toHex(new Uint8Array(digest))}`;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
