/** A Word or PowerPoint chip that could not be opened, so it shows a plain line instead. */
export interface OfficeChipNotice {
  file: string;
  message: string;
}

/** 2a name for the same notice. The store is shared by .docx and .pptx. */
export type DocxChipNotice = OfficeChipNotice;

let notice: OfficeChipNotice | null = null;
const listeners = new Set<() => void>();

export function getOfficeChipNotice(): OfficeChipNotice | null {
  return notice;
}

export function setOfficeChipNotice(next: OfficeChipNotice | null): void {
  notice = next;
  for (const listener of listeners) listener();
}

export function subscribeOfficeChipNotice(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const getDocxChipNotice = getOfficeChipNotice;
export const setDocxChipNotice = setOfficeChipNotice;
export const subscribeDocxChipNotice = subscribeOfficeChipNotice;
