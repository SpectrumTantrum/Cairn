// Vault images are indexed by path only. There is no text layer, no OCR, and no embedding.

/** Shown when Ask or the editor is asked to read an image as text. */
export const IMAGE_NO_TEXT = "This file is an image, so Cairn cannot read its text.";

/** png, jpg, jpeg, webp, and gif. Video and audio stay out. */
export function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|webp|gif)$/i.test(path);
}

/** MIME type for an in-app `<img>` data URL. Null when the path is not an image. */
export function imageMimeType(path: string): string | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return null;
}
