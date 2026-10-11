// Vault audio is indexed by path only. There is no transcript, no text body, and no embedding.

/** Shown when Ask or the editor is asked to read an audio file as text. */
export const AUDIO_NO_TEXT = "This file is audio, so Cairn cannot read its text.";

/** mp3, wav, and m4a. Video stays out. */
export function isAudioPath(path: string): boolean {
  return /\.(mp3|wav|m4a)$/i.test(path);
}

/** MIME type for an in-app `<audio>` data URL. Null when the path is not audio. */
export function audioMimeType(path: string): string | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  return null;
}
