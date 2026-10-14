/**
 * Where the chat scroller should sit after a thread update.
 * A new Ask appends a turn below the fold — especially the first Ask after
 * Stop, which removes the streaming draft and leaves the view on the old
 * question. Follow that new turn. A Stop shrinks the thread, and token
 * updates keep the same length, so neither should move the scroll.
 */
export function chatFollowScrollTop(input: {
  previousCount: number;
  nextCount: number;
  scrollTop: number;
  /** Content Y of the new turn inside the scroller. */
  turnTop: number;
}): number {
  if (input.nextCount <= input.previousCount) return input.scrollTop;
  return Math.max(0, input.turnTop);
}
