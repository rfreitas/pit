/**
 * Git filesystem utilities — reads git state directly from the filesystem.
 * No side effects beyond filesystem reads, except listRepoWorktrees and
 * gitRepoRoot/branchExists which spawn git processes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync, execFileSync } from "node:child_process";

// ── linked worktree detection ─────────────────────────────────────────────────

/**
 * Return true if cwd is a linked git worktree (not a main checkout or submodule).
 * A linked worktree has .git as a plain file with a gitdir path containing /.git/worktrees/.
 */
export function isLinkedWorktree(cwd: string): boolean {
  try {
    const gitPath = path.join(cwd, ".git");
    if (fs.statSync(gitPath).isDirectory()) return false;
    const gitdir = fs.readFileSync(gitPath, "utf8").trim().replace(/^gitdir:\s*/, "");
    return gitdir.includes("/.git/worktrees/");
  } catch {
    return false;
  }
}

/**
 * Resolve the main repo root from a linked worktree's .git pointer file.
 * Returns null if cwd is not a linked worktree or the path cannot be resolved.
 */
export function resolveMainRepo(cwd: string): string | null {
  try {
    const gitPath = path.join(cwd, ".git");
    if (fs.statSync(gitPath).isDirectory()) return null;
    const gitdir = fs.readFileSync(gitPath, "utf8").trim().replace(/^gitdir:\s*/, "");
    if (!gitdir.includes("/.git/worktrees/")) return null;
    return path.resolve(gitdir, "../../..");
  } catch {
    return null;
  }
}

/**
 * Read the current branch name for a linked worktree without running git.
 * Returns null for main checkouts, submodules, detached HEAD, or deleted worktrees.
 */
export function readWorktreeBranch(cwd: string): string | null {
  try {
    const gitPath = path.join(cwd, ".git");
    if (fs.statSync(gitPath).isDirectory()) return null;
    const gitdir = fs.readFileSync(gitPath, "utf8").trim().replace(/^gitdir:\s*/, "");
    if (!gitdir.includes("/.git/worktrees/")) return null;
    const head = fs.readFileSync(path.join(gitdir, "HEAD"), "utf8").trim();
    const m = head.match(/^ref: refs\/heads\/(.+)$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Read the gitdir path for a linked worktree (.git/worktrees/<id>/).
 * Used to locate worktree-scoped git state such as MERGE_HEAD.
 * Returns null for main checkouts, submodules, or any error.
 */
export function readWorktreeGitdir(cwd: string): string | null {
  try {
    const gitPath = path.join(cwd, ".git");
    if (fs.statSync(gitPath).isDirectory()) return null;
    const gitdir = fs.readFileSync(gitPath, "utf8").trim().replace(/^gitdir:\s*/, "");
    if (!gitdir.includes("/.git/worktrees/")) return null;
    return gitdir;
  } catch {
    return null;
  }
}

/**
 * List all linked worktrees for a git repository (excludes the main checkout).
 * Returns an empty array for non-git dirs or if git is unavailable.
 */
export function listRepoWorktrees(repo: string): string[] {
  try {
    const out = execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const paths: string[] = [];
    let currentPath = "";
    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) {
        currentPath = line.slice(9).trim();
      } else if (line === "" && currentPath) {
        if (currentPath !== repo) paths.push(currentPath);
        currentPath = "";
      }
    }
    return paths;
  } catch {
    return [];
  }
}

// ── repo root and branch existence ────────────────────────────────────────────

/** Return the git repo root for the current directory, or null if not in a repo. */
export function gitRepoRoot(): string | null {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

/** Return true if the given branch exists in the repo. */
export function branchExists(repo: string, branch: string): boolean {
  try {
    execFileSync(
      "git",
      ["-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

// ── worktree git rw mounts ────────────────────────────────────────────────────

/**
 * Resolve rw git mount paths for a linked worktree.
 * Returns the two paths needed for git operations inside bwrap:
 *   - the worktree metadata dir  (index, HEAD, ORIG_HEAD, lock files)
 *   - the shared objects store   (blobs, trees, commits)
 * Returns [] for main worktrees, non-git dirs, or any error.
 */
export function resolveWorktreeGitRwMounts(cwd: string): Array<{ path: string; label?: string }> {
  try {
    const gitPath = path.join(cwd, ".git");
    if (fs.statSync(gitPath).isDirectory()) return [];
    const worktreeDir = fs.readFileSync(gitPath, "utf8").trim().replace(/^gitdir:\s*/, "");
    const mainGitDir = path.resolve(worktreeDir, "../..");
    return [
      { path: worktreeDir, label: "worktree git metadata" },
      { path: path.join(mainGitDir, "objects"), label: "git objects" },
    ];
  } catch {
    return [];
  }
}
