import { app, BrowserWindow, Menu, nativeTheme, shell } from "electron";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerIpcHandlers } from "./ipc";
import { browserWindowChromeOptions, TITLEBAR_COLOR, windowChromeKind } from "../shared/window-chrome.js";

const currentDir = dirname(fileURLToPath(import.meta.url));

/**
 * Emit a boot-lifecycle marker. Always logs to stderr; when CAIRN_BOOT_MARKER
 * points at a file, also appends there. The file sink exists because a directly
 * launched macOS .app does not reliably forward main-process stdout/stderr to a
 * redirect, so packaging smoke tests need a deterministic on-disk signal that
 * app-ready fired and the renderer loaded. No-op in normal use (env unset).
 */
function bootMarker(stage: string): void {
  console.error(`[cairn] ${stage}`);
  const target = process.env.CAIRN_BOOT_MARKER;
  if (target) {
    try {
      appendFileSync(target, `${Date.now()} ${stage}\n`);
    } catch {
      // Diagnostic sink only; never let it affect app startup.
    }
  }
}

/** Dark-theme the OS chrome we still keep (dialogs, overlay buttons). */
function applyNativeDarkTheme(): void {
  nativeTheme.themeSource = "dark";
}

/**
 * macOS: keep a standard application menu in the *screen* menu bar (Edit roles
 * for copy/paste). Linux/Windows: drop Electron's default File/Edit/View/Window
 * bar — that bar is native and cannot take Cairn's tokens; the renderer titlebar
 * replaces it.
 */
function installApplicationMenu(): void {
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: "appMenu" },
        { role: "editMenu" },
        { role: "viewMenu" },
        { role: "windowMenu" },
      ]),
    );
    return;
  }
  Menu.setApplicationMenu(null);
}

function createWindow(): void {
  const chrome = browserWindowChromeOptions(windowChromeKind(process.platform));
  const mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 960,
    minHeight: 640,
    title: "Cairn",
    backgroundColor: TITLEBAR_COLOR,
    show: false,
    ...chrome,
    webPreferences: {
      preload: join(currentDir, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  // Boot markers for packaging smoke tests. did-finish-load fires once the
  // renderer bundle has loaded from the packaged asar (a reliable boot signal
  // even headless, where ready-to-show can stall waiting on first paint).
  mainWindow.webContents.on("did-finish-load", () => {
    bootMarker("renderer did-finish-load");
  });
  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    bootMarker(`renderer did-fail-load code=${code} desc=${desc} url=${url}`);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(currentDir, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  applyNativeDarkTheme();
  installApplicationMenu();
  registerIpcHandlers();
  createWindow();
  bootMarker("app-ready window-created");

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
