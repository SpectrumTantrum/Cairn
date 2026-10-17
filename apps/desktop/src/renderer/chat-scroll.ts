/** A reader this close to the bottom (px) is following the stream. */
export const CHAT_FOLLOW_THRESHOLD = 64;

export function chatDistanceFromBottom(scroller: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): number {
  return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
}

/**
 * Where the chat scroller should sit after a thread update.
 * `distanceFromBottom` is the gap before this update grew the content — chips
 * and tokens increase `scrollHeight`, so measuring after layout looks like the
 * reader scrolled away. Follow to the new bottom when a turn is appended, or
 * when they were already near the bottom (the stream, then the chips). A Stop
 * shrinks the thread and leaves the scroll where it was. A reader who scrolled
 * up is not pulled down by tokens or chips.
 */
export function chatFollowScrollTop(input: {
  previousCount: number;
  nextCount: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  distanceFromBottom: number;
}): number {
  if (input.nextCount < input.previousCount) return input.scrollTop;
  const grew = input.nextCount > input.previousCount;
  const nearBottom = input.distanceFromBottom <= CHAT_FOLLOW_THRESHOLD;
  if (grew || nearBottom) return Math.max(0, input.scrollHeight - input.clientHeight);
  return input.scrollTop;
}
