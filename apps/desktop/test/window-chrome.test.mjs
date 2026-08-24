// Pure-logic gate for window chrome (themed titlebar). Locks the platform →
// BrowserWindow option mapping so Linux/Windows do not grow a native File/Edit
// menu bar, and macOS keeps hiddenInset traffic lights. React TitleBar wiring
// is verified in the running app.

import assert from "node:assert/strict";
import { test } from "node:test";

const {
  windowChromeKind,
  windowChromeKindFromNavigator,
  browserWindowChromeOptions,
  TITLEBAR_COLOR,
  TITLEBAR_HEIGHT,
} = await import("../out-test/window-chrome.js");

test("macOS uses traffic-light chrome", () => {
  assert.equal(windowChromeKind("darwin"), "traffic-lights");
});

test("Windows uses overlay caption buttons", () => {
  assert.equal(windowChromeKind("win32"), "overlay");
});

test("Linux (and anything else) uses custom frameless chrome", () => {
  assert.equal(windowChromeKind("linux"), "custom");
  assert.equal(windowChromeKind("freebsd"), "custom");
});

test("navigator.platform maps to the same kinds as process.platform", () => {
  assert.equal(windowChromeKindFromNavigator("MacIntel"), "traffic-lights");
  assert.equal(windowChromeKindFromNavigator("Win32"), "overlay");
  assert.equal(windowChromeKindFromNavigator("Linux x86_64"), "custom");
});

test("traffic-lights options hide the native titlebar and place the lights", () => {
  const opts = browserWindowChromeOptions("traffic-lights");
  assert.equal(opts.titleBarStyle, "hiddenInset");
  assert.deepEqual(opts.trafficLightPosition, { x: 14, y: 12 });
  assert.equal(opts.autoHideMenuBar, true);
  assert.equal(opts.frame, undefined);
});

test("overlay options paint caption buttons in the vault-rail color", () => {
  const opts = browserWindowChromeOptions("overlay");
  assert.equal(opts.titleBarStyle, "hidden");
  assert.deepEqual(opts.titleBarOverlay, {
    color: TITLEBAR_COLOR,
    symbolColor: "#c6c8cc",
    height: TITLEBAR_HEIGHT,
  });
  assert.equal(opts.autoHideMenuBar, true);
});

test("custom chrome is frameless so the renderer owns min/max/close", () => {
  const opts = browserWindowChromeOptions("custom");
  assert.equal(opts.frame, false);
  assert.equal(opts.autoHideMenuBar, true);
  assert.equal(opts.titleBarStyle, undefined);
});
