// Type stubs for `wawoff2` — a pure-JS port of Google's woff2 tool that
// `@types/wawoff2` doesn't ship. We only use `decompress` (woff2 → OTF
// bytes) on the server side via /api/font.

declare module 'wawoff2' {
  /**
   * Decompress a WOFF2 buffer to its underlying OTF/TTF bytes.
   * Resolves to a Uint8Array containing the decompressed font.
   */
  export function decompress(input: Uint8Array | Buffer): Promise<Uint8Array>;

  /**
   * Compress an OTF/TTF buffer to WOFF2. Not used by SubIFI — included
   * here for completeness so consumers don't get a type error if they
   * import it.
   */
  export function compress(input: Uint8Array | Buffer): Promise<Uint8Array>;
}
