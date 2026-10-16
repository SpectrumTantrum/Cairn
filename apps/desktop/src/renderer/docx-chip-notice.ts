/** The Word chip that could not be opened, so it shows a plain line instead. */
export interface DocxChipNotice {
  file: string;
  message: string;
}

let notice: DocxChipNotice | null = null;
const listeners = new Set<() => void>();

export function getDocxChipNotice(): DocxChipNotice | null {
  return notice;
}

export function setDocxChipNotice(next: DocxChipNotice | null): void {
  notice = next;
  for (const listener of listeners) listener();
}

export function subscribeDocxChipNotice(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
