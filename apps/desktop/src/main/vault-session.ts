import {
  ask,
  ChatThread,
  indexVault,
  openIndex,
  runAgent,
  search,
  type AskResult,
  type ChatSendResult,
  type EditProposal,
  type Index,
  type IndexStats,
  type SearchHit,
} from "@cairn/engine";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ConcurrencyAbort,
  commitCheckpoint,
  commitRun,
  gitAvailable,
  revertRun,
} from "./agent-checkpoint.js";

export interface VaultSessionDeps {
  openIndex: (vaultRoot: string) => Index;
}

/** A folder or file node in the vault file tree (main-process source of truth). */
export interface TreeNode {
  /** Basename, as shown in the tree. */
  name: string;
  /** Vault-relative path using POSIX separators (stable id + IPC arg for read/write). */
  path: string;
  /** `markdown` opens the CM6 editor; `other` opens a disabled host; `folder` expands. */
  type: "folder" | "markdown" | "other";
  /** Present only on folders. */
  children?: TreeNode[];
}

/** Folders before files; then natural (numeric-aware) case-insensitive name order. */
function compareTreeNodes(a: TreeNode, b: TreeNode): number {
  const aFolder = a.type === "folder";
  const bFolder = b.type === "folder";
  if (aFolder !== bFolder) return aFolder ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
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
export interface ChatSendOpts {
  model?: string;
  scope?: string[];
  onToken?: (token: string) => void;
}

/** Result of starting an Agent run — the collected proposals, nothing applied yet. */
export interface AgentStartResult {
  runId: string;
  answer: string;
  proposals: EditProposal[];
  sources: SearchHit[];
  steps: number;
  stopReason: string;
  grounded: boolean;
  model?: string;
}

/** Result of a per-hunk approval decision. `content` is echoed so the editor can refresh. */
export interface AgentApplyResult {
  runId: string;
  proposalId: string;
  status: "applied" | "rejected" | "skipped";
  path: string;
  /** Present on `applied` — the new on-disk content, so the open editor can rebind. */
  content?: string;
  /** Present on `skipped` — why the write was refused (e.g. external edit). */
  reason?: string;
  appliedCount: number;
  rejectedCount: number;
}

interface AppliedRecord {
  path: string;
  op: "add" | "modify";
}

/** Live state for the single in-flight Agent run (one run at a time in this slice). */
interface ActiveRun {
  runId: string;
  proposals: Map<string, EditProposal>;
  resolved: Set<string>;
  applied: AppliedRecord[];
  rejected: string[];
  /** Checkpoint commit A — lazily created immediately before the FIRST apply. */
  checkpointSha: string | null;
  /** Run-commit B — amended per apply so there is exactly one commit per run. */
  runCommitSha: string | null;
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export class VaultSession {
  private selectedVaultPath: string | null = null;
  private readonly openIndexFn: (vaultRoot: string) => Index;

  // The active multi-turn chat. The thread holds conversation history, so its
  // backing Index stays open for the thread's lifetime (retrieval runs per turn).
  // Reset on new-thread, vault switch, or reindex; the token stream flows out via
  // the per-send `onToken` callback the IPC bridge forwards to the renderer.
  private chatThread: ChatThread | null = null;
  private chatIndex: Index | null = null;

  // The single in-flight Agent run (ADR-0008). Reset on vault switch / reindex.
  private activeRun: ActiveRun | null = null;

  constructor(deps: VaultSessionDeps) {
    this.openIndexFn = deps.openIndex;
  }

  getSelectedPath(): string | null {
    return this.selectedVaultPath;
  }

  setVault(path: string): string {
    const vaultPath = normalizeVaultPath(path);
    if (vaultPath !== this.selectedVaultPath) {
      this.resetChat();
      this.activeRun = null;
    }
    this.selectedVaultPath = vaultPath;
    return vaultPath;
  }

  clearVault(): void {
    this.resetChat();
    this.activeRun = null;
    this.selectedVaultPath = null;
  }

  /** Drop the active thread and close its Index. Called on new-thread / vault switch / reindex. */
  resetChat(): void {
    if (this.chatIndex) {
      try {
        this.chatIndex.close();
      } catch {
        // Already closed or never opened; a reset must never throw.
      }
      this.chatIndex = null;
    }
    this.chatThread = null;
  }

  private ensureChatThread(): ChatThread {
    const vaultPath = this.requireVault();
    this.assertIndexed(vaultPath);
    if (!this.chatThread) {
      this.chatIndex = this.openIndexFn(vaultPath);
      this.chatThread = new ChatThread(this.chatIndex, { mode: "auto" });
    }
    return this.chatThread;
  }

  /**
   * Multi-turn grounded chat turn. Streams tokens via `opts.onToken` (the IPC bridge
   * forwards them to the renderer) and resolves to the full grounded result. The
   * thread history + backing Index are preserved across turns until `resetChat()`.
   */
  async chatSend(text: string, opts: ChatSendOpts = {}): Promise<ChatSendResult> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("Ask needs a question.");
    }
    const thread = this.ensureChatThread();
    return thread.send(trimmed, {
      model: opts.model,
      scope: opts.scope,
      onToken: opts.onToken,
    });
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
    const stats = await indexVault(vaultPath, { lexical: !!opts.lexical });
    // The index changed on disk; drop any live thread so the next turn rebinds
    // to the freshly-built index rather than a stale open connection. A live Agent
    // run's proposals were derived from the pre-reindex vault, so drop it too.
    this.resetChat();
    this.activeRun = null;
    return stats;
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

  async ask(question: string, opts: { model?: string; scope?: string[] } = {}): Promise<AskResult> {
    const vaultPath = this.requireVault();
    this.assertIndexed(vaultPath);
    const trimmed = question.trim();
    if (!trimmed) {
      throw new Error("Ask needs a question.");
    }

    return this.withIndex(vaultPath, (index) =>
      ask(index, trimmed, { mode: "auto", model: opts.model, scope: opts.scope }),
    );
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

  /**
   * Recursively list the vault as a folder/file tree for the vault rail. Folders and
   * files are returned sorted (folders first, natural name order); dotfiles and the
   * `.cairn` index dir are skipped, and symlinks are never followed (escape + loop
   * safety). `rel` optionally scopes the listing to a subdirectory, path-validated
   * against the vault root the same way reads/writes are.
   */
  listTree(rel = ""): TreeNode[] {
    const vaultRoot = this.requireVault();
    const startDir = rel.trim() === "" ? vaultRoot : resolveInsideVault(vaultRoot, rel);
    return this.readTree(vaultRoot, startDir);
  }

  private readTree(vaultRoot: string, dir: string): TreeNode[] {
    const nodes: TreeNode[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = entry.name;
      if (name.startsWith(".")) continue; // hidden dotfiles + the .cairn index dir
      if (entry.isSymbolicLink()) continue; // never follow symlinks out of the vault
      const abs = join(dir, name);
      const relPath = relative(vaultRoot, abs).split(sep).join("/");
      if (entry.isDirectory()) {
        nodes.push({ name, path: relPath, type: "folder", children: this.readTree(vaultRoot, abs) });
      } else if (entry.isFile()) {
        const type = name.toLowerCase().endsWith(".md") ? "markdown" : "other";
        nodes.push({ name, path: relPath, type });
      }
    }
    nodes.sort(compareTreeNodes);
    return nodes;
  }

  // ---- Agent write-loop (ADR-0008) --------------------------------------------
  // Start collects proposals (engine never writes); apply is the per-hunk approval
  // gate — the only path to disk, and every write goes through the same
  // path-validation as source:write. Revert is the byte-identical run undo.

  /**
   * Start an Agent run: drive the bounded tool loop and collect proposed edits as
   * pending diffs. Applies NOTHING and creates NO git commit — that happens only on
   * per-hunk approval. Supersedes any prior in-flight run.
   */
  async agentStart(goal: string, opts: { model?: string; scope?: string[] } = {}): Promise<AgentStartResult> {
    const vaultPath = this.requireVault();
    this.assertIndexed(vaultPath);
    const trimmed = goal.trim();
    if (!trimmed) {
      throw new Error("Agent needs a task to work on.");
    }

    const index = this.openIndexFn(vaultPath);
    try {
      const result = await runAgent({
        index,
        goal: trimmed,
        model: opts.model,
        scope: opts.scope,
        // The engine's only side-effect seam: a vault-scoped, path-validated reader.
        readNote: async (rel) => this.readSource(rel),
      });
      const runId = randomUUID();
      this.activeRun = {
        runId,
        proposals: new Map(result.proposals.map((p) => [p.id, p])),
        resolved: new Set(),
        applied: [],
        rejected: [],
        checkpointSha: null,
        runCommitSha: null,
      };
      return {
        runId,
        answer: result.answer,
        proposals: result.proposals,
        sources: result.sources,
        steps: result.steps,
        stopReason: result.stopReason,
        grounded: result.grounded,
        model: result.model,
      };
    } finally {
      index.close();
    }
  }

  private requireRun(runId: string): ActiveRun {
    if (!this.activeRun || this.activeRun.runId !== runId) {
      throw new Error("This agent run is no longer active. Start a new one.");
    }
    return this.activeRun;
  }

  /**
   * Approve one proposed edit — THE gate. Creates checkpoint A before the run's first
   * apply, runs the concurrency check (never clobber an external edit), writes through
   * the same validation as source:write, and folds the write into the single run-commit B.
   */
  async agentApplyHunk(runId: string, proposalId: string): Promise<AgentApplyResult> {
    const vaultPath = this.requireVault();
    const run = this.requireRun(runId);
    const proposal = run.proposals.get(proposalId);
    if (!proposal) {
      throw new Error("That proposed edit is not part of this run.");
    }
    if (run.resolved.has(proposalId)) {
      throw new Error("That proposed edit was already resolved.");
    }

    if (!(await gitAvailable())) {
      throw new Error(
        "Agent mode needs git installed to snapshot before writing. Install git, or reject these edits.",
      );
    }

    // Concurrency check (ADR-0008 §3) — immediately before the write.
    const target = this.resolveSourcePath(proposal.path);
    if (proposal.op === "modify") {
      const onDisk = existsSync(target) && statSync(target).isFile() ? readFileSync(target, "utf8") : null;
      if (onDisk === null || sha256(onDisk) !== proposal.baseHash) {
        run.resolved.add(proposalId);
        return this.applyOutcome(run, proposalId, "skipped", proposal.path, {
          reason: new ConcurrencyAbort(proposal.path).message,
        });
      }
    } else if (existsSync(target)) {
      // op === "add" but the path appeared on disk since we proposed it.
      run.resolved.add(proposalId);
      return this.applyOutcome(run, proposalId, "skipped", proposal.path, {
        reason: new ConcurrencyAbort(proposal.path).message,
      });
    }

    // Checkpoint A — captured before the FIRST apply of the run (ADR-0008 §1 step 1).
    if (run.checkpointSha === null) {
      run.checkpointSha = await commitCheckpoint(vaultPath, run.runId);
    }

    // Ensure the parent dir exists for a new note, then write through source validation.
    mkdirSync(dirname(target), { recursive: true });
    this.writeSource(proposal.path, proposal.newContent);

    run.applied.push({ path: proposal.path, op: proposal.op });
    run.resolved.add(proposalId);

    // Fold into the single run-commit B (amend after the first), staging ONLY approved paths.
    const approvedPaths = run.applied.map((a) => a.path);
    run.runCommitSha = await commitRun(vaultPath, run.runId, approvedPaths, run.runCommitSha !== null);

    return this.applyOutcome(run, proposalId, "applied", proposal.path, { content: proposal.newContent });
  }

  /** Reject one proposed edit — no disk change, no commit; purely records the decision. */
  agentRejectHunk(runId: string, proposalId: string): AgentApplyResult {
    const run = this.requireRun(runId);
    const proposal = run.proposals.get(proposalId);
    if (!proposal) {
      throw new Error("That proposed edit is not part of this run.");
    }
    if (run.resolved.has(proposalId)) {
      throw new Error("That proposed edit was already resolved.");
    }
    run.rejected.push(proposalId);
    run.resolved.add(proposalId);
    return this.applyOutcome(run, proposalId, "rejected", proposal.path, {});
  }

  private applyOutcome(
    run: ActiveRun,
    proposalId: string,
    status: AgentApplyResult["status"],
    path: string,
    extra: { content?: string; reason?: string },
  ): AgentApplyResult {
    return {
      runId: run.runId,
      proposalId,
      status,
      path,
      content: extra.content,
      reason: extra.reason,
      appliedCount: run.applied.length,
      rejectedCount: run.rejected.length,
    };
  }

  /**
   * Revert an entire run to its checkpoint — byte-identical (ADR-0008 §4). No-op when
   * nothing was applied (no run-commit exists). Asserts tree(C) === tree(A) or throws.
   */
  async agentRevertRun(runId: string): Promise<{ reverted: boolean }> {
    const vaultPath = this.requireVault();
    const run = this.requireRun(runId);
    if (run.checkpointSha === null || run.runCommitSha === null) {
      return { reverted: false }; // nothing was applied; nothing to revert
    }
    await revertRun(vaultPath, run.checkpointSha, run.runCommitSha, run.runId);
    this.activeRun = null;
    return { reverted: true };
  }

  /**
   * Write an editor buffer back to a vault-relative Markdown path. Rejects paths that
   * escape the vault lexically (`../`), that resolve out of the vault through a symlink,
   * or that are not `.md` (ADR-0009: index & cite everything, edit only Markdown).
   */
  writeSource(file: string, content: string): void {
    const target = this.resolveSourcePath(file);
    if (!target.toLowerCase().endsWith(".md")) {
      throw new Error("Refusing to write a non-Markdown file.");
    }
    const vaultRoot = this.requireVault();
    this.assertNoSymlinkEscape(vaultRoot, target);
    writeFileSync(target, content, "utf8");
  }

  /**
   * Reject writes whose real (symlink-resolved) location falls outside the vault.
   * `resolveInsideVault` is purely lexical, so a symlinked directory inside the vault
   * pointing elsewhere would otherwise let a write escape. We realpath the deepest
   * existing ancestor of the target and require it to stay under the vault root.
   */
  private assertNoSymlinkEscape(vaultRoot: string, target: string): void {
    let probe = target;
    while (!existsSync(probe)) {
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    const real = realpathSync.native(probe);
    const rel = relative(vaultRoot, real);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error("Refusing to write a path outside the selected vault.");
    }
  }
}

export function createVaultSession(deps: Partial<VaultSessionDeps> = {}): VaultSession {
  return new VaultSession({
    openIndex: deps.openIndex ?? openIndex,
  });
}
