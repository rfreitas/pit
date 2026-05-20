/**
 * Worktree IO — subprocess calls to create and manage git worktrees.
 */

import * as fs from "node:fs";
import { execSync, execFileSync } from "node:child_process";
import { gitRepoRoot, branchExists } from "../git/utils.ts";
import { genId, buildNoTreeMeta, buildWorktreeMeta } from "./pure.ts";
import type { PitMetadata, WorktreeResult } from "../types.ts";

// ── worktree creation / recreation ────────────────────────────────────────────

export function createWorktree({ branch, worktree }: { branch: string; worktree: string }): void {
  console.error("pit: creating worktree");
  console.error(`  branch:   ${branch}`);
  console.error(`  worktree: ${worktree}`);
  execFileSync("git", ["worktree", "add", "-b", branch, worktree, "HEAD"], { stdio: ["ignore", process.stderr, process.stderr] });
}

export function recreateWorktree({ repo, branch, worktree }: { repo: string; branch: string; worktree: string }): void {
  console.error("pit: worktree missing, attempting to recreate…");
  if (!branchExists(repo, branch)) {
    console.error(`pit: branch '${branch}' no longer exists — cannot recreate worktree`);
    process.exit(1);
  }
  try {
    execSync("git worktree prune", { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-C", repo, "worktree", "add", worktree, branch], { stdio: ["ignore", process.stderr, process.stderr] });
  } catch (e: unknown) {
    console.error(`pit: failed to recreate worktree: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  console.error(`pit: worktree recreated at ${worktree}`);
}

// ── worktree check ────────────────────────────────────────────────────────────

/**
 * Determine launch mode and cwd.
 *
 * - Resume (existingMeta provided): verify/recreate the existing worktree.
 * - New session: check for git, create a worktree if possible, else no-tree.
 *   Pass forceNoTree=true to skip worktree creation even inside a git repo.
 */
export function worktreeCheck(existingMeta?: PitMetadata, forceNoTree = false): WorktreeResult {
  if (existingMeta) {
    if (existingMeta.mode === "no-tree") {
      return { mode: "no-tree", cwd: existingMeta.worktree, meta: existingMeta };
    }
    if (!fs.existsSync(existingMeta.worktree)) {
      recreateWorktree(existingMeta);
    }
    return { mode: "worktree", cwd: existingMeta.worktree, meta: existingMeta };
  }

  const repo = gitRepoRoot();
  const cwd = process.cwd();
  const id = genId();
  const created = new Date().toISOString();

  if (!repo) {
    return { mode: "no-tree", cwd, meta: buildNoTreeMeta(cwd, cwd, "no-repo", id, created) };
  }
  if (forceNoTree) {
    return { mode: "no-tree", cwd, meta: buildNoTreeMeta(cwd, repo, "forced", id, created) };
  }

  const meta = buildWorktreeMeta(repo, id, created);
  createWorktree(meta);
  return { mode: "worktree", cwd: meta.worktree, meta };
}
