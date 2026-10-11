// Vault video is indexed by path only. There is no transcript, no text body, and no embedding.

/** Shown when Ask or the editor is asked to read a video file as text. */
export const VIDEO_NO_TEXT = "This file is video, so Cairn cannot read its text.";

/** mp4, webm, and mov. Other containers stay out. */
export function isVideoPath(path: string): boolean {
  return /\.(mp4|webm|mov)$/i.test(path);
}

/** MIME type for an in-app `<video>` data URL. Null when the path is not video. */
export function videoMimeType(path: string): string | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mov")) return "video/quicktime";
  return null;
}
