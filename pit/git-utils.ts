/**
 * Pure git path utilities — no pi dependencies, safe to import from anywhere
 * including standalone processes like pit-escape.
 *
 * All functions read git metadata directly from the filesystem; none run
 * git commands except listRepoWorktrees.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Return true if cwd is a linked git worktree (not a main checkout or submodule).
 * Detection is based on the .git-file invariant: a linked worktree always has
 * .git as a plain file with a gitdir path containing /.git/worktrees/.
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
 * worktree/.git contains "gitdir: <mainRepo>/.git/worktrees/<id>"
 * so mainRepo = gitdir/../../..
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
 * Read the current branch name for a linked worktree.
 * Returns null if the directory is not a linked worktree, is detached HEAD,
 * or no longer exists (e.g. the worktree was deleted after the session was created).
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
 * Used by pit -r to include worktree sessions in the picker's current-tab.
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
