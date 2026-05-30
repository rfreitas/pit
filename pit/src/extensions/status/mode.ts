/**
 * pit mode footer — shows worktree/no-tree mode and sandbox status in the
 * pi status bar on every session start.
 *
 * Examples:
 *   "worktree: pi/80096d01"  +  "sandbox"
 *   "no-tree"                +  "no sandbox"
 *
 * Mode is derived from live git state (isLinkedWorktree + readWorktreeBranch),
 * never from stored session metadata. Uses plain node:fs to avoid jiti/Effect
 * runtime issues in extension context.
 */

import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const isLinkedWorktreeSync = (cwd: string): boolean => {
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

const readWorktreeBranchSync = (cwd: string): string | null => {
  const gitPath = join(cwd, ".git");
  try {
    const content = readFileSync(gitPath, "utf8").trim();
    const gitdir = content.replace(/^gitdir:\s*/, "");
    const head = readFileSync(join(gitdir, "HEAD"), "utf8").trim();
    const m = head.match(/^ref:\s*refs\/heads\/(\S+)$/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
};

export const createModeStatus = (
  socketPath: string,
): ExtensionFactory => (pi: ExtensionAPI) => {
  pi.on("session_start", async (_event, ctx) => {
    const cwd = ctx.cwd;

    if (isLinkedWorktreeSync(cwd)) {
      const branch = readWorktreeBranchSync(cwd);
      ctx.ui.setStatus("pit-mode", `worktree: ${branch ?? "?"}`);
    } else {
      ctx.ui.setStatus("pit-mode", "no-tree");
    }

    // Sandbox: escape socket present ↔ sandbox active
    ctx.ui.setStatus("pit-sandbox", socketPath ? "sandbox" : "no sandbox");
  });
};
