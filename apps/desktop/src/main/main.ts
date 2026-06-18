import { app, BrowserWindow, shell } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerIpcHandlers } from "./ipc";

const currentDir = dirname(fileURLToPath(import.meta.url));

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 960,
    minHeight: 640,
    title: "Cairn",
    backgroundColor: "#f6f5ef",
    show: false,
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
  registerIpcHandlers();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
