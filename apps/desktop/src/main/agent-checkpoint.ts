// Agent write-safety: git checkpoints, gated per-hunk apply commits, and a
// hand-rolled byte-identical run revert (ADR-0008 §1–§4).
//
// DIVERGENCE FROM ADR-0008 §0 (flagged, deliberate): the ADR specifies
// "isomorphic-git only; never mix with system git." This build uses SYSTEM git via
// execFile instead, per the Phase-3 dispatch's zero-new-dependency directive
// (isomorphic-git would be a new npm dep; the hard license/dep policy prefers zero).
// Two mitigations keep the ADR's guarantees intact:
//   1. We never touch the user's own `.git`. All checkpoint history lives in a
//      DEDICATED repo at `<vault>/.cairn/checkpoints.git` with the vault as its
//      work-tree — disposable, never-synced (CONTEXT.md), invisible to the user's
//      own git. This also removes the ADR's "never hard-reset — you'd nuke unrelated
//      history" hazard, because the history is ours.
//   2. `core.autocrlf=false` on that repo neutralises the exact autocrlf/byte-identity
//      concern the ADR cited for banning system git.
// The ADR's provable acceptance test is preserved verbatim: revert asserts
// tree(C) === tree(A) via `git rev-parse <c>^{tree}`.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CHECKPOINT_GITDIR = join(".cairn", "checkpoints.git");

/** Raised when a file changed on disk between propose and apply — never clobber it (ADR-0008 §3). */
export class ConcurrencyAbort extends Error {
  constructor(public readonly path: string) {
    super(`"${path}" changed on disk since the agent read it — skipped.`);
    this.name = "ConcurrencyAbort";
  }
}

function gitEnv(vaultRoot: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_DIR: join(vaultRoot, CHECKPOINT_GITDIR),
    GIT_WORK_TREE: vaultRoot,
    // Deterministic, non-interactive identity so commits never depend on user git config.
    GIT_AUTHOR_NAME: "Cairn Agent",
    GIT_AUTHOR_EMAIL: "agent@cairn.local",
    GIT_COMMITTER_NAME: "Cairn Agent",
    GIT_COMMITTER_EMAIL: "agent@cairn.local",
  };
}

async function git(vaultRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { env: gitEnv(vaultRoot), cwd: vaultRoot });
  return stdout.trim();
}

/** True if a usable `git` binary is on PATH — Agent apply refuses (clearly) when false. */
export async function gitAvailable(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the dedicated checkpoint repo exists and is configured. Idempotent.
 * Excludes `.cairn/` so the disposable index and this repo itself are never committed.
 */
export async function ensureCheckpointRepo(vaultRoot: string): Promise<void> {
  const gitDir = join(vaultRoot, CHECKPOINT_GITDIR);
  const fresh = !existsSync(gitDir);
  if (fresh) {
    mkdirSync(join(vaultRoot, ".cairn"), { recursive: true });
    await git(vaultRoot, ["init", "-q"]);
    await git(vaultRoot, ["config", "core.autocrlf", "false"]);
    await git(vaultRoot, ["config", "user.name", "Cairn Agent"]);
    await git(vaultRoot, ["config", "user.email", "agent@cairn.local"]);
  }
  // (Re)write the exclude every time — cheap, and self-heals a deleted file.
  const infoDir = join(gitDir, "info");
  mkdirSync(infoDir, { recursive: true });
  writeFileSync(join(infoDir, "exclude"), ".cairn/\n", "utf8");
}

/**
 * Checkpoint A (ADR-0008 §1 step 1): commit the user's current dirty tree so revert
 * operates strictly on the A→B delta. `--allow-empty` so a clean vault still yields a
 * baseline commit. Returns the checkpoint commit sha.
 */
export async function commitCheckpoint(vaultRoot: string, runId: string): Promise<string> {
  await ensureCheckpointRepo(vaultRoot);
  await git(vaultRoot, ["add", "-A"]); // excludes .cairn/ via info/exclude
  await git(vaultRoot, ["commit", "-q", "--allow-empty", "-m", `cairn: checkpoint before agent run ${runId}`]);
  return git(vaultRoot, ["rev-parse", "HEAD"]);
}

/**
 * Commit run-commit B — stages ONLY the approved paths (never `add -A`), so a
 * concurrent external edit is never swept in (ADR-0008 §1). Amends the single
 * run-commit when it already exists, keeping exactly one commit per run.
 */
export async function commitRun(
  vaultRoot: string,
  runId: string,
  approvedPaths: string[],
  amend: boolean,
): Promise<string> {
  for (const p of approvedPaths) {
    await git(vaultRoot, ["add", "--", p]);
  }
  const message = `cairn: agent run ${runId} (${approvedPaths.length} file${approvedPaths.length === 1 ? "" : "s"})`;
  const args = ["commit", "-q", "-m", message];
  if (amend) args.push("--amend");
  await git(vaultRoot, args);
  return git(vaultRoot, ["rev-parse", "HEAD"]);
}

export async function treeOf(vaultRoot: string, ref: string): Promise<string> {
  return git(vaultRoot, ["rev-parse", `${ref}^{tree}`]);
}

export interface RevertResult {
  treeA: string;
  treeC: string;
  /** True iff tree(C) === tree(A) — the provable byte-identity assertion (ADR-0008 §4). */
  byteIdentical: boolean;
  revertCommit: string;
}

/**
 * "Revert this run" — the hand-rolled procedure (ADR-0008 §4). Restores modified +
 * deleted paths from checkpoint A, deletes agent-created paths, forward-commits C,
 * and asserts tree(C) === tree(A). NEVER hard-resets. Throws if the assertion fails.
 */
export async function revertRun(
  vaultRoot: string,
  checkpointA: string,
  runCommitB: string,
  runId: string,
): Promise<RevertResult> {
  const treeA = await treeOf(vaultRoot, checkpointA);

  // Authoritative change-set = the A↔B tree diff (not a log; the tree is truth).
  const nameStatus = await git(vaultRoot, ["diff", "--name-status", checkpointA, runCommitB]);
  const restore: string[] = [];
  const created: string[] = [];
  for (const line of nameStatus.split("\n")) {
    if (!line.trim()) continue;
    const [status, ...rest] = line.split("\t");
    const path = rest.join("\t");
    if (status.startsWith("A")) created.push(path);
    else restore.push(path); // M, D, and rename/type-change targets all restore from A
  }

  if (restore.length) {
    await git(vaultRoot, ["checkout", checkpointA, "--", ...restore]);
    await git(vaultRoot, ["add", "--", ...restore]); // defensive re-stage (ADR-0008 §4 step 4)
  }
  for (const path of created) {
    const abs = join(vaultRoot, path);
    if (existsSync(abs)) {
      // isomorphic-git lacks `git clean`; system git's `rm` deletes the working file too.
      await git(vaultRoot, ["rm", "-q", "-f", "--", path]);
    } else {
      await git(vaultRoot, ["rm", "-q", "--cached", "--", path]).catch(() => undefined);
    }
  }

  await git(vaultRoot, ["commit", "-q", "--allow-empty", "-m", `cairn: revert agent run ${runId}`]);
  const revertCommit = await git(vaultRoot, ["rev-parse", "HEAD"]);
  const treeC = await treeOf(vaultRoot, revertCommit);
  const byteIdentical = treeA === treeC;
  if (!byteIdentical) {
    // Do NOT mark the run reverted — the vault is not provably restored (ADR-0008 §4).
    throw new Error(
      `Revert is unsafe: the restored tree does not match the checkpoint (tree ${treeC} !== ${treeA}).`,
    );
  }
  return { treeA, treeC, byteIdentical, revertCommit };
}
