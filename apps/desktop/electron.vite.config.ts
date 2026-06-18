import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import type { Plugin } from "vite";

const appRoot = dirname(fileURLToPath(import.meta.url));

function cspPlugin(): Plugin {
  return {
    name: "cairn-csp",
    transformIndexHtml(html, context) {
      const isDev = Boolean(context.server);
      const scriptSrc = isDev ? "'self' 'unsafe-inline'" : "'self'";
      const connectSrc = isDev
        ? "'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*"
        : "'self'";
      const csp = [
        "default-src 'self'",
        `script-src ${scriptSrc}`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        `connect-src ${connectSrc}`,
      ].join("; ");

      return html.replace("%CAIRN_CSP%", csp);
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          main: resolve(appRoot, "src/main/main.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(appRoot, "src/preload/index.ts"),
        },
      },
    },
  },
  renderer: {
    root: resolve(appRoot, "src/renderer"),
    plugins: [cspPlugin(), react()],
    build: {
      rollupOptions: {
        input: resolve(appRoot, "src/renderer/index.html"),
      },
    },
  },
});
