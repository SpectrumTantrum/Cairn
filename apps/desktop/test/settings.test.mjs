// Pure-logic gate for the typed UI-preferences module (issue #24). Covers the read/write
// contract that replaces App.tsx's scattered raw localStorage access: defaults, round-trip,
// clamp/validation, and tolerance of unknown/corrupt persisted values. The React wiring
// (settings panel, pane-reset hook) is verified manually — this locks the storage logic.

import assert from "node:assert/strict";
import { test } from "node:test";

const {
  DEFAULT_RIGHT_TAB,
  RIGHT_WIDTH,
  SETTINGS_KEYS,
  VAULT_WIDTH,
  readPaneWidth,
  readRightTab,
  writePaneWidth,
  writeRightTab,
} = await import("../out-test/settings.js");

/** Minimal in-memory SettingsStore fake (structurally matches window.localStorage). */
function fakeStore(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

// ---- right-rail tab -------------------------------------------------------

test("readRightTab returns the default when nothing is persisted", () => {
  assert.equal(readRightTab(fakeStore()), DEFAULT_RIGHT_TAB);
  assert.equal(DEFAULT_RIGHT_TAB, "chat");
});

test("readRightTab returns a valid persisted tab", () => {
  assert.equal(readRightTab(fakeStore({ [SETTINGS_KEYS.rightTab]: "sources" })), "sources");
});

test("readRightTab tolerates an unknown/corrupt value by falling back to the default", () => {
  assert.equal(readRightTab(fakeStore({ [SETTINGS_KEYS.rightTab]: "bogus" })), DEFAULT_RIGHT_TAB);
});

test("writeRightTab / readRightTab round-trip through the store", () => {
  const store = fakeStore();
  writeRightTab(store, "studio");
  assert.equal(store.getItem(SETTINGS_KEYS.rightTab), "studio");
  assert.equal(readRightTab(store), "studio");
});

// ---- pane widths ----------------------------------------------------------

test("readPaneWidth returns the spec default when absent", () => {
  assert.equal(readPaneWidth(fakeStore(), VAULT_WIDTH), VAULT_WIDTH.initial);
  assert.equal(readPaneWidth(fakeStore(), RIGHT_WIDTH), RIGHT_WIDTH.initial);
});

test("readPaneWidth returns an in-range persisted width", () => {
  const store = fakeStore({ [VAULT_WIDTH.key]: "300" });
  assert.equal(readPaneWidth(store, VAULT_WIDTH), 300);
});

test("readPaneWidth falls back to default for out-of-range and non-numeric values", () => {
  assert.equal(readPaneWidth(fakeStore({ [VAULT_WIDTH.key]: "10000" }), VAULT_WIDTH), VAULT_WIDTH.initial);
  assert.equal(readPaneWidth(fakeStore({ [VAULT_WIDTH.key]: "5" }), VAULT_WIDTH), VAULT_WIDTH.initial);
  assert.equal(readPaneWidth(fakeStore({ [VAULT_WIDTH.key]: "wide" }), VAULT_WIDTH), VAULT_WIDTH.initial);
});

test("writePaneWidth rounds and round-trips", () => {
  const store = fakeStore();
  writePaneWidth(store, VAULT_WIDTH, 246.7);
  assert.equal(store.getItem(VAULT_WIDTH.key), "247");
  assert.equal(readPaneWidth(store, VAULT_WIDTH), 247);
});
