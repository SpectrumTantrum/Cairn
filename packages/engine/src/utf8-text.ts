// Plain-text vault files are UTF-8. Invalid sequences and NUL bytes are binary
// junk: they are not indexed, and a read reports that instead of a replacement
// string or an empty citation.

/** Thrown message when a `.txt` file is not valid UTF-8 text. The tool prefixes `ERROR:`. */
export const INVALID_UTF8_MESSAGE = "This file is not valid UTF-8 text, so Cairn cannot read it.";

/** Thrown when a `.csv` or `.tsv` file has no rows. The tool prefixes `ERROR:`. */
export const EMPTY_TABLE_MESSAGE = "This file is empty, so Cairn cannot read it.";

/** Decoded text, or null when `bytes` is not UTF-8 or contains a NUL. */
export function decodeUtf8Text(bytes: Uint8Array): string | null {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
