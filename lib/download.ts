// Small helper to trigger a file download from a Blob or Uint8Array.

export function downloadBlob(
  data: Blob | Uint8Array | string,
  filename: string,
  mime = 'application/octet-stream',
): void {
  let blob: Blob;
  if (data instanceof Blob) {
    blob = data;
  } else if (typeof data === 'string') {
    blob = new Blob([data], { type: mime });
  } else {
    // Uint8Array: cast to BlobPart — TS 5.6+ generic Uint8Array<ArrayBufferLike>
    // isn't directly assignable to BlobPart but the runtime value is fine.
    blob = new Blob([data as BlobPart], { type: mime });
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
