/**
 * Synchronous Git utilities — lightweight, dependency-free wrappers
 * that execute synchronous readFileSync/statSync. Shared by extensions and hooks
 * to avoid jiti/Effect async initialization overhead.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Checks if the given CWD is a linked git worktree.
 */
export const isLinkedWorktreeSync = (cwd: string): boolean => {
  const gitPath = join(cwd, ".git");
  try {
    const info = statSync(gitPath);
    if (!info.isFile()) return false;
    const content = readFileSync(gitPath, "utf8").trim();
    const gitdir = content.replace(/^gitdir:\s*/, "");
    return gitdir.includes("/.git/worktrees/");
  } catch {
    return false;
  }
};

/**
 * Read the checked-out branch name from the worktree's HEAD.
 * Returns null if the worktree gitdir or HEAD is unreadable/deleted.
 */
export const readWorktreeBranchSync = (cwd: string): string | null => {
  const gitPath = join(cwd, ".git");
  try {
    const info = statSync(gitPath);
    const gitdir = info.isFile() ? readFileSync(gitPath, "utf8").trim().replace(/^gitdir:\s*/, "") : gitPath;
    const head = readFileSync(join(gitdir, "HEAD"), "utf8").trim();
    const m = head.match(/^ref:\s*refs\/heads\/(\S+)$/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
};
