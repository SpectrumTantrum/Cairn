// After Stop, the next Ask appends below the previous question. The chat
// scroller has to follow that new turn. Streaming tokens and the Stop itself
// must leave the scroll where the reader put it. React has no node harness,
// so the geometry is unit-tested and the ChatTab wiring is locked in source.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const { chatFollowScrollTop } = await import("../out-test/chat-scroll.js");

const chatTab = readFileSync(new URL("../src/renderer/components/shell/ChatTab.tsx", import.meta.url), "utf8");

function slice(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from !== -1 && to !== -1, `missing slice ${start}`);
  return source.slice(from, to);
}

test("the first Ask after a Stop scrolls to the new turn", () => {
  const afterStop = chatFollowScrollTop({
    previousCount: 4,
    nextCount: 3,
    scrollTop: 480,
    turnTop: 900,
  });
  assert.equal(afterStop, 480);

  const nextAsk = chatFollowScrollTop({
    previousCount: 3,
    nextCount: 5,
    scrollTop: 480,
    turnTop: 640,
  });
  assert.equal(nextAsk, 640);
});

test("a token update does not pull the scroll, and the first turn does", () => {
  assert.equal(
    chatFollowScrollTop({ previousCount: 2, nextCount: 2, scrollTop: 120, turnTop: 400 }),
    120,
  );
  assert.equal(
    chatFollowScrollTop({ previousCount: 0, nextCount: 2, scrollTop: 0, turnTop: 12 }),
    12,
  );
  assert.equal(
    chatFollowScrollTop({ previousCount: 0, nextCount: 2, scrollTop: 0, turnTop: -4 }),
    0,
  );
});

test("ChatTab follows the new user turn when the thread grows", () => {
  const fn = slice(chatTab, "export function ChatTab", "function useNow");
  assert.match(fn, /data-chat-turn="user"/);
  assert.match(fn, /ref=\{scrollerRef\}/);
  assert.match(fn, /chatFollowScrollTop\(/);
  assert.match(fn, /scroller\.scrollTop = chatFollowScrollTop/);
  assert.match(fn, /\[thread\.length\]/);
  assert.match(fn, /querySelectorAll<HTMLElement>\("\[data-chat-turn='user'\]"\)/);
});
