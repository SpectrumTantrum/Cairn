import { BrowserWindow, WebContentsView } from "electron";
import { pdfFileUrl } from "../shared/pdf-open.js";

const views = new WeakMap<BrowserWindow, WebContentsView>();
const loadedUrl = new WeakMap<WebContentsView, string>();

function ensureView(win: BrowserWindow): WebContentsView {
  const existing = views.get(win);
  if (existing && !existing.webContents.isDestroyed()) return existing;
  const view = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      plugins: true,
    },
  });
  views.set(win, view);
  win.contentView.addChildView(view);
  win.once("closed", () => {
    views.delete(win);
    loadedUrl.delete(view);
  });
  return view;
}

export interface PdfViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Show `absPath` in the window's PDF view. `page` is 1-based and becomes `#page=N`. */
export function showPdfView(win: BrowserWindow, absPath: string, page: number | undefined, bounds: PdfViewBounds): void {
  const view = ensureView(win);
  const width = Math.max(0, Math.round(bounds.width));
  const height = Math.max(0, Math.round(bounds.height));
  if (width <= 0 || height <= 0) {
    view.setVisible(false);
    return;
  }
  view.setBounds({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width,
    height,
  });
  view.setVisible(true);
  const url = pdfFileUrl(absPath, page);
  if (loadedUrl.get(view) !== url) {
    loadedUrl.set(view, url);
    void view.webContents.loadURL(url);
  }
}

export function hidePdfView(win: BrowserWindow): void {
  const view = views.get(win);
  if (!view || view.webContents.isDestroyed()) return;
  view.setVisible(false);
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
}
