/**
 * Window chrome policy for the desktop shell.
 *
 * Electron's default File / Edit / View / Window bar is native OS chrome — it
 * cannot take Cairn's dark tokens. We hide that bar and draw a themed titlebar
 * instead. Platform pick:
 *   - macOS: hiddenInset titlebar; traffic lights sit in our bar (system menu
 *     stays in the screen menu bar, which is the macOS convention).
 *   - Windows: hidden titlebar + titleBarOverlay so caption buttons match.
 *   - Linux: frameless window + renderer-drawn min/max/close.
 */

export type WindowChromeKind = "traffic-lights" | "overlay" | "custom";

/** Matches `--pane-vault` so the titlebar reads as the same surface as the rails. */
export const TITLEBAR_COLOR = "#161719";
export const TITLEBAR_SYMBOL = "#c6c8cc";
export const TITLEBAR_HEIGHT = 36;

export function windowChromeKind(platform: string): WindowChromeKind {
  if (platform === "darwin") return "traffic-lights";
  if (platform === "win32") return "overlay";
  return "custom";
}

/** `navigator.platform` is "MacIntel" / "Win32" / "Linux x86_64", not Node's `process.platform`. */
export function windowChromeKindFromNavigator(platform: string): WindowChromeKind {
  if (/mac/i.test(platform)) return "traffic-lights";
  if (/win/i.test(platform)) return "overlay";
  return "custom";
}

export interface WindowChromeSnapshot {
  kind: WindowChromeKind;
  maximized: boolean;
}

/** BrowserWindow fields that implement the chrome kind. No Electron import — unit-tested. */
export function browserWindowChromeOptions(kind: WindowChromeKind): {
  titleBarStyle?: "hiddenInset" | "hidden";
  trafficLightPosition?: { x: number; y: number };
  titleBarOverlay?: { color: string; symbolColor: string; height: number };
  frame?: boolean;
  autoHideMenuBar: boolean;
} {
  if (kind === "traffic-lights") {
    return {
      titleBarStyle: "hiddenInset",
      // Vertically center the 12px lights in the 36px titlebar.
      trafficLightPosition: { x: 14, y: 12 },
      autoHideMenuBar: true,
    };
  }
  if (kind === "overlay") {
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: TITLEBAR_COLOR,
        symbolColor: TITLEBAR_SYMBOL,
        height: TITLEBAR_HEIGHT,
      },
      autoHideMenuBar: true,
    };
  }
  return {
    frame: false,
    autoHideMenuBar: true,
  };
}
