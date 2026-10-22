import assert from "node:assert/strict";
import { test } from "node:test";

const { dispatchDocxOpen, noAppMessage } = await import("../out-test/docx-open.js");

function fakeChild(emit) {
  const listeners = { error: [], exit: [] };
  const child = {
    unrefed: false,
    on(event, listener) {
      listeners[event].push(listener);
    },
    unref() {
      child.unrefed = true;
    },
  };
  queueMicrotask(() => emit(listeners, child));
  return child;
}

test("docx open resolves when the opener never settles", async () => {
  const started = Date.now();
  let child;
  const result = await dispatchDocxOpen("/tmp/vault/roster.docx", "roster.docx", {
    platform: "linux",
    timeoutMs: 40,
    spawnXdg: () => {
      child = fakeChild(() => {});
      return child;
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(child.unrefed, true);
  assert.ok(Date.now() - started < 2_000);

  let logged = 0;
  const hung = await dispatchDocxOpen("/tmp/vault/roster.docx", "roster.docx", {
    platform: "darwin",
    timeoutMs: 40,
    openPath: () => new Promise(() => {}),
    log: () => {
      logged += 1;
    },
  });
  assert.deepEqual(hung, { ok: true });
  assert.equal(logged, 0);
});

test("docx open returns an error when xdg-open exits non-zero", async () => {
  const missing = await dispatchDocxOpen("/tmp/vault/roster.docx", "roster.docx", {
    platform: "linux",
    timeoutMs: 2_000,
    spawnXdg: () => fakeChild((listeners) => listeners.exit.forEach((fn) => fn(3, null))),
  });
  assert.deepEqual(missing, { ok: false, message: noAppMessage("roster.docx") });

  const gone = await dispatchDocxOpen("/tmp/vault/roster.docx", "roster.docx", {
    platform: "linux",
    timeoutMs: 2_000,
    spawnXdg: () => fakeChild((listeners) => listeners.exit.forEach((fn) => fn(2, null))),
  });
  assert.deepEqual(gone, { ok: false, message: "File not found" });

  const other = await dispatchDocxOpen("/tmp/vault/roster.docx", "roster.docx", {
    platform: "linux",
    timeoutMs: 2_000,
    spawnXdg: () => fakeChild((listeners) => listeners.exit.forEach((fn) => fn(1, null))),
  });
  assert.deepEqual(other, { ok: false, message: "Could not open roster.docx" });
});

test("docx open returns an error when xdg-open is missing", async () => {
  const result = await dispatchDocxOpen("/tmp/vault/roster.docx", "roster.docx", {
    platform: "linux",
    timeoutMs: 2_000,
    spawnXdg: () =>
      fakeChild((listeners) => {
        const error = Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" });
        listeners.error.forEach((fn) => fn(error));
      }),
  });
  assert.deepEqual(result, { ok: false, message: "No app found to open roster.docx" });
});

test("docx open treats a shell error string as no-app and a late rejection as handled", async () => {
  const lines = [];
  const blocked = await dispatchDocxOpen("/tmp/vault/roster.docx", "roster.docx", {
    platform: "win32",
    timeoutMs: 2_000,
    openPath: async () => "Failed to open path",
    log: (line) => lines.push(line),
  });
  assert.deepEqual(blocked, { ok: false, message: "No app found to open roster.docx" });
  assert.equal(lines.length, 1);

  let rejectLate;
  const hung = dispatchDocxOpen("/tmp/vault/roster.docx", "roster.docx", {
    platform: "darwin",
    timeoutMs: 30,
    openPath: () =>
      new Promise((_resolve, reject) => {
        rejectLate = reject;
      }),
    log: (line) => lines.push(line),
  });
  assert.deepEqual(await hung, { ok: true });
  rejectLate(new Error("late"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(lines.length, 2);
});

test("docx open returns ok when xdg-open exits 0", async () => {
  const started = Date.now();
  const result = await dispatchDocxOpen("/tmp/vault/roster.docx", "roster.docx", {
    platform: "linux",
    timeoutMs: 2_000,
    spawnXdg: () => fakeChild((listeners) => listeners.exit.forEach((fn) => fn(0, null))),
  });
  assert.deepEqual(result, { ok: true });
  assert.ok(Date.now() - started < 1_000);
});
