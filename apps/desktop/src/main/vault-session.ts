import {
  ask,
  indexVault,
  openIndex,
  search,
  type AskResult,
  type Index,
  type IndexStats,
  type SearchHit,
} from "@cairn/engine";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface VaultSessionDeps {
  openIndex: (vaultRoot: string) => Index;
}

function normalizeVaultPath(input: string): string {
  if (input.trim() === "") {
    throw new Error("Choose a vault folder first.");
  }
  const vaultPath = resolve(input);
  if (!existsSync(vaultPath) || !statSync(vaultPath).isDirectory()) {
    throw new Error("The selected vault folder no longer exists.");
  }
  return realpathSync.native(vaultPath);
}

function resolveInsideVault(vaultPath: string, file: string): string {
  if (file.trim() === "") {
    throw new Error("No source file was provided.");
  }
  const target = resolve(vaultPath, file);
  const rel = relative(vaultPath, target);
  if (rel.startsWith("..") || rel === "" || isAbsolute(rel)) {
    throw new Error("Refusing to open a path outside the selected vault.");
  }
  return target;
}

/** Active vault policy + Mneme orchestration for the desktop shell (main process). */
export class VaultSession {
  private selectedVaultPath: string | null = null;
  private readonly openIndexFn: (vaultRoot: string) => Index;

  constructor(deps: VaultSessionDeps) {
    this.openIndexFn = deps.openIndex;
  }

  getSelectedPath(): string | null {
    return this.selectedVaultPath;
  }

  setVault(path: string): string {
    const vaultPath = normalizeVaultPath(path);
    this.selectedVaultPath = vaultPath;
    return vaultPath;
  }

  clearVault(): void {
    this.selectedVaultPath = null;
  }

  requireVault(): string {
    if (!this.selectedVaultPath) {
      throw new Error("Choose a vault folder first.");
    }
    return this.selectedVaultPath;
  }

  private assertIndexed(vaultPath: string): void {
    if (!existsSync(join(vaultPath, ".cairn", "index.db"))) {
      throw new Error("Index this vault before searching or asking.");
    }
  }

  private async withIndex<T>(vaultPath: string, fn: (index: Index) => Promise<T>): Promise<T> {
    const index = this.openIndexFn(vaultPath);
    return fn(index).finally(() => {
      index.close();
    });
  }

  async index(opts: { lexical?: boolean } = {}): Promise<IndexStats> {
    const vaultPath = this.requireVault();
    return indexVault(vaultPath, { lexical: !!opts.lexical });
  }

  async search(query: string): Promise<SearchHit[]> {
    const vaultPath = this.requireVault();
    this.assertIndexed(vaultPath);
    const trimmed = query.trim();
    if (!trimmed) return [];

    return this.withIndex(vaultPath, async (index) => {
      const result = await search(index, trimmed, { mode: "auto" });
      return result.hits;
    });
  }

  async ask(question: string): Promise<AskResult> {
    const vaultPath = this.requireVault();
    this.assertIndexed(vaultPath);
    const trimmed = question.trim();
    if (!trimmed) {
      throw new Error("Ask needs a question.");
    }

    return this.withIndex(vaultPath, (index) => ask(index, trimmed, { mode: "auto" }));
  }

  resolveSourcePath(file: string): string {
    return resolveInsideVault(this.requireVault(), file);
  }

  /** Read a vault-relative source file for in-app viewing. Path-validated against the vault root. */
  readSource(file: string): string {
    const target = this.resolveSourcePath(file);
    if (!existsSync(target) || !statSync(target).isFile()) {
      throw new Error("The source file is no longer available. Try re-indexing this vault.");
    }
    return readFileSync(target, "utf8");
  }
}

export function createVaultSession(deps: Partial<VaultSessionDeps> = {}): VaultSession {
  return new VaultSession({
    openIndex: deps.openIndex ?? openIndex,
  });
}
