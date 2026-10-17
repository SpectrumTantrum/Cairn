// Streaming answers grow downward, and the citation chips arrive with the
// settled turn. Follow that only when the reader was already near the bottom.
// A scroll-up must stick. A new Ask still jumps to the new turn, and Stop
// must not move the scroll. React has no node harness, so the geometry is
// unit-tested and the ChatTab wiring is locked in source.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const { CHAT_FOLLOW_THRESHOLD, chatFollowScrollTop } = await import("../out-test/chat-scroll.js");

const chatTab = readFileSync(new URL("../src/renderer/components/shell/ChatTab.tsx", import.meta.url), "utf8");

function slice(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from !== -1 && to !== -1, `missing slice ${start}`);
  return source.slice(from, to);
}

const view = { scrollHeight: 1100, clientHeight: 400 };

test("a stream and the chips follow only when the reader was near the bottom", () => {
  assert.equal(CHAT_FOLLOW_THRESHOLD, 64);
  const followed = chatFollowScrollTop({
    previousCount: 2,
    nextCount: 2,
    scrollTop: 390,
    ...view,
    distanceFromBottom: 10,
  });
  assert.equal(followed, 700);

  const stayed = chatFollowScrollTop({
    previousCount: 2,
    nextCount: 2,
    scrollTop: 40,
    ...view,
    distanceFromBottom: 200,
  });
  assert.equal(stayed, 40);
});

test("a new Ask follows even from the top, and Stop does not move the scroll", () => {
  const nextAsk = chatFollowScrollTop({
    previousCount: 2,
    nextCount: 4,
    scrollTop: 40,
    ...view,
    distanceFromBottom: 800,
  });
  assert.equal(nextAsk, 700);

  const stopped = chatFollowScrollTop({
    previousCount: 4,
    nextCount: 3,
    scrollTop: 480,
    scrollHeight: 900,
    clientHeight: 400,
    distanceFromBottom: 0,
  });
  assert.equal(stopped, 480);
});

test("the follow threshold is inclusive and a short thread clamps at zero", () => {
  const base = {
    previousCount: 2,
    nextCount: 2,
    scrollTop: 100,
    scrollHeight: 1000,
    clientHeight: 300,
  };
  assert.equal(chatFollowScrollTop({ ...base, distanceFromBottom: 64 }), 700);
  assert.equal(chatFollowScrollTop({ ...base, distanceFromBottom: 65 }), 100);
  assert.equal(
    chatFollowScrollTop({
      previousCount: 0,
      nextCount: 2,
      scrollTop: 0,
      scrollHeight: 20,
      clientHeight: 400,
      distanceFromBottom: 0,
    }),
    0,
  );
});

test("ChatTab follows the thread when pinned and does not yank a scroll-up", () => {
  const fn = slice(chatTab, "export function ChatTab", "function useNow");
  assert.match(fn, /onScroll=\{rememberChatFollow\}/);
  assert.match(fn, /useLayoutEffect/);
  assert.match(fn, /distanceRef/);
  assert.match(fn, /chatDistanceFromBottom\(scroller\)/);
  assert.match(fn, /chatFollowScrollTop\(/);
  assert.match(fn, /\[thread\]/);
  assert.equal(fn.includes("[thread.length]"), false);
  const panel = slice(chatTab, "function AgenticProgressPanel", "function ErrorTurn");
  assert.equal(panel.includes("scrollIntoView"), false);
});
