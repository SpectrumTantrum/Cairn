// ThreadStore gate (issue #25). No Electron: the store lives in a tmp dir with an
// injected clock. Proves the persistence invariants:
//   * save → list → load round-trips the opaque turn payloads;
//   * list returns metadata (no turns) sorted newest-updated first;
//   * an update keeps createdAt, advances updatedAt, and preserves the id;
//   * delete removes only the targeted thread;
//   * a corrupt / partially-written store file degrades to empty, never throws;
//   * threads survive a "restart" (a fresh ThreadStore over the same file).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const { ThreadStore } = await import("../out-test/thread-store.js");

/** A store over a fresh tmp file, with a controllable clock so timestamps are deterministic. */
function makeStore(clock) {
  const dir = mkdtempSync(join(tmpdir(), "cairn-thread-store-"));
  const filePath = join(dir, "chat-threads.json");
  const now = clock ?? (() => Date.now());
  return { store: new ThreadStore({ filePath, now }), filePath, dir };
}

/** A tiny serialized ChatTurn[] — the store treats these opaquely. */
function sampleTurns(q = "What is a cairn?") {
  return [
    { role: "user", text: q },
    {
      role: "assistant",
      streaming: false,
      result: { answer: "A stack of stones.", covered: true, sources: [] },
    },
  ];
}

test("save then load round-trips the opaque turn payloads", () => {
  const { store, dir } = makeStore();
  try {
    const turns = sampleTurns();
    const meta = store.save({ title: "Cairns", turns });
    assert.match(meta.id, /^thread_/);
    assert.equal(meta.title, "Cairns");
    assert.equal(meta.turnCount, 2);

    const loaded = store.load(meta.id);
    assert.ok(loaded);
    assert.equal(loaded.id, meta.id);
    assert.deepEqual(loaded.turns, turns);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("list returns metadata (no turns) newest-updated first", () => {
  let t = 1000;
  const { store, dir } = makeStore(() => t);
  try {
    t = 1000;
    const a = store.save({ title: "Oldest", turns: sampleTurns("a") });
    t = 2000;
    const b = store.save({ title: "Middle", turns: sampleTurns("b") });
    t = 3000;
    const c = store.save({ title: "Newest", turns: sampleTurns("c") });

    const list = store.list();
    assert.deepEqual(
      list.map((m) => m.id),
      [c.id, b.id, a.id],
    );
    // Metadata view carries no turn payloads.
    for (const m of list) {
      assert.equal("turns" in m, false);
      assert.equal(m.turnCount, 2);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("update keeps id + createdAt, advances updatedAt, replaces turns", () => {
  let t = 5000;
  const { store, dir } = makeStore(() => t);
  try {
    t = 5000;
    const created = store.save({ title: "Draft", turns: sampleTurns("first") });
    const before = store.load(created.id);
    assert.equal(before.createdAt, 5000);
    assert.equal(before.updatedAt, 5000);

    t = 9000;
    const updatedTurns = [...sampleTurns("first"), { role: "user", text: "follow-up" }];
    const updated = store.save({ id: created.id, title: "Draft", turns: updatedTurns });
    assert.equal(updated.id, created.id);
    assert.equal(updated.turnCount, 3);

    const after = store.load(created.id);
    assert.equal(after.createdAt, 5000, "createdAt is preserved on update");
    assert.equal(after.updatedAt, 9000, "updatedAt advances on update");
    assert.deepEqual(after.turns, updatedTurns);
    assert.equal(store.list().length, 1, "update does not create a duplicate");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("title falls back to 'New thread' when empty/omitted", () => {
  const { store, dir } = makeStore();
  try {
    const a = store.save({ turns: sampleTurns() });
    const b = store.save({ title: "   ", turns: sampleTurns() });
    assert.equal(a.title, "New thread");
    assert.equal(b.title, "New thread");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("delete removes only the targeted thread; load then returns null", () => {
  const { store, dir } = makeStore();
  try {
    const a = store.save({ title: "Keep", turns: sampleTurns("keep") });
    const b = store.save({ title: "Drop", turns: sampleTurns("drop") });
    assert.equal(store.has(b.id), true);

    store.delete(b.id);
    assert.equal(store.has(b.id), false);
    assert.equal(store.load(b.id), null);
    assert.equal(store.has(a.id), true);
    assert.equal(store.list().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt store file degrades to empty instead of throwing", () => {
  const { store, filePath, dir } = makeStore();
  try {
    writeFileSync(filePath, "{ this is not valid json ]", "utf8");
    // A fresh store reads the corrupt file lazily; must not throw.
    const fresh = new ThreadStore({ filePath });
    assert.deepEqual(fresh.list(), []);
    // And it recovers: a subsequent save produces a well-formed file.
    const meta = fresh.save({ title: "Recovered", turns: sampleTurns() });
    const onDisk = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(onDisk.threads.length, 1);
    assert.equal(onDisk.threads[0].id, meta.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file with a non-array `threads` degrades to empty", () => {
  const { filePath, dir } = makeStore();
  try {
    writeFileSync(filePath, JSON.stringify({ version: 1, threads: "nope" }), "utf8");
    const store = new ThreadStore({ filePath });
    assert.deepEqual(store.list(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed thread records are dropped, well-formed ones kept", () => {
  const { filePath, dir } = makeStore();
  try {
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        threads: [
          { id: "good", title: "Good", createdAt: 1, updatedAt: 1, turns: [] },
          { id: "bad-no-turns", title: "Bad", createdAt: 1, updatedAt: 1 },
          { title: "Bad no id", createdAt: 1, updatedAt: 1, turns: [] },
          "not even an object",
        ],
      }),
      "utf8",
    );
    const store = new ThreadStore({ filePath });
    const list = store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, "good");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("threads survive a restart (a fresh store over the same file)", () => {
  const { store, filePath, dir } = makeStore();
  try {
    const first = store.save({ title: "Session 1", turns: sampleTurns("q1") });
    const second = store.save({ title: "Session 2", turns: sampleTurns("q2") });

    // Simulate an app restart: throw away the in-memory cache, re-instantiate.
    const reopened = new ThreadStore({ filePath });
    const list = reopened.list();
    assert.equal(list.length, 2);
    assert.deepEqual(new Set(list.map((m) => m.id)), new Set([first.id, second.id]));

    // Full turns are still recoverable after the "restart".
    const loaded = reopened.load(first.id);
    assert.deepEqual(loaded.turns, sampleTurns("q1"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
