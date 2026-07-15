// Chat thread history store (issue #25). Persists renderer chat threads in the app's
// userData dir so conversations survive an app restart. Hard rules enforced here:
//   * Threads live in userData, NOT the vault: chat history is not vault content and
//     must never be indexed or cited as a retrieval source.
//   * Electron is not imported — the file path is injected — so this module runs under
//     `node --test` against a tmp dir with no Electron runtime.
//   * `turns` are stored OPAQUELY (`unknown[]`): the store persists whatever the
//     renderer's serialized `ChatTurn[]` is without coupling to that UI type. Only the
//     lightweight metadata (title/timestamps/count) is interpreted here.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** On-disk record. `turns` is the renderer's serialized ChatTurn[], kept opaque. */
interface StoredThread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: unknown[];
}

interface StoreFile {
  version: 1;
  threads: StoredThread[];
}

/** Lightweight list view — no turn payloads, cheap to render in the history list. */
export interface ThreadMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
}

/** Full thread as returned by `load` — carries the opaque turn payloads. */
export interface ThreadRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: unknown[];
}

/** Draft from the renderer. Omit `id` to create; supply it to update in place. */
export interface ThreadSaveInput {
  id?: string;
  title?: string;
  turns: unknown[];
}

function toMeta(t: StoredThread): ThreadMeta {
  return {
    id: t.id,
    title: t.title,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    turnCount: t.turns.length,
  };
}

function normalizeTitle(title: string | undefined): string {
  const trimmed = typeof title === "string" ? title.trim() : "";
  return trimmed.length > 0 ? trimmed : "New thread";
}

let idCounter = 0;
function mintId(): string {
  idCounter += 1;
  return `thread_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

export class ThreadStore {
  private readonly filePath: string;
  /** Injectable clock so tests can assert createdAt/updatedAt behavior deterministically. */
  private readonly now: () => number;
  private cache: StoreFile | null = null;

  constructor(deps: { filePath: string; now?: () => number }) {
    this.filePath = deps.filePath;
    this.now = deps.now ?? Date.now;
  }

  /** Metadata for every thread, newest-updated first. No turn payloads. */
  list(): ThreadMeta[] {
    return this.read()
      .threads.map(toMeta)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  has(id: string): boolean {
    return this.read().threads.some((t) => t.id === id);
  }

  /** Full thread with its turns, or null if it no longer exists. */
  load(id: string): ThreadRecord | null {
    const found = this.read().threads.find((t) => t.id === id);
    if (!found) return null;
    return {
      id: found.id,
      title: found.title,
      createdAt: found.createdAt,
      updatedAt: found.updatedAt,
      turns: found.turns,
    };
  }

  /**
   * Create or update a thread. On update the original `createdAt` is preserved and
   * `updatedAt` advances; on create both are set to now. Returns metadata (the caller
   * needs the minted id to keep updating the same thread on subsequent saves).
   */
  save(input: ThreadSaveInput): ThreadMeta {
    const store = this.read();
    const turns = Array.isArray(input.turns) ? input.turns : [];
    const now = this.now();
    const id = input.id && input.id.length > 0 ? input.id : mintId();
    const existing = store.threads.find((t) => t.id === id);

    const record: StoredThread = {
      id,
      title: normalizeTitle(input.title),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      turns,
    };

    const next = existing
      ? store.threads.map((t) => (t.id === id ? record : t))
      : [...store.threads, record];
    this.write({ version: 1, threads: next });
    return toMeta(record);
  }

  delete(id: string): void {
    const store = this.read();
    this.write({ version: 1, threads: store.threads.filter((t) => t.id !== id) });
  }

  private read(): StoreFile {
    if (this.cache) return this.cache;
    if (!existsSync(this.filePath)) {
      this.cache = { version: 1, threads: [] };
      return this.cache;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<StoreFile>;
      // Corrupt / partially-written / hand-edited file: fall back to an empty store
      // rather than throwing, so a single bad write can never brick chat history.
      this.cache = Array.isArray(parsed?.threads)
        ? { version: 1, threads: parsed.threads.filter(isStoredThread) }
        : { version: 1, threads: [] };
    } catch {
      this.cache = { version: 1, threads: [] };
    }
    return this.cache;
  }

  private write(store: StoreFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(store, null, 2), "utf8");
    this.cache = store;
  }
}

/** Defensive shape guard for records read off disk (untrusted after hand-edits). */
function isStoredThread(value: unknown): value is StoredThread {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    typeof t.title === "string" &&
    typeof t.createdAt === "number" &&
    typeof t.updatedAt === "number" &&
    Array.isArray(t.turns)
  );
}
