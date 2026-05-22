/**
 * subscribe op — persistent socket that pushes ref-change events.
 * Kept fully imperative: watch push events are callback-driven.
 * No display logic — errors propagate to the socket boundary (server.ts).
 */

import { existsSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Socket } from "node:net";
import { detectParentBranch } from "./git.ts";

export const handleSubscribe = (socket: Socket, worktreePath: string): void => {
  // Sync helpers — used in callback context where async is not available
  const syncReadWorktreeBranch = (cwd: string): string | null => {
    try {
      const gitPath = join(cwd, ".git");
      if (statSync(gitPath).isDirectory()) return null;
      const gitdir = readFileSync(gitPath, "utf8").trim().replace(/^gitdir:\s*/, "");
      if (!gitdir.includes("/.git/worktrees/")) return null;
      const head = readFileSync(join(gitdir, "HEAD"), "utf8").trim();
      const m = head.match(/^ref: refs\/heads\/(.+)$/);
      return m ? m[1] : null;
    } catch { return null; }
  };

  const syncResolveMainRepo = (cwd: string): string | null => {
    try {
      const gitPath = join(cwd, ".git");
      if (statSync(gitPath).isDirectory()) return null;
      const gitdir = readFileSync(gitPath, "utf8").trim().replace(/^gitdir:\s*/, "");
      if (!gitdir.includes("/.git/worktrees/")) return null;
      return resolve(gitdir, "../../..");
    } catch { return null; }
  };

  const mainRepo = syncResolveMainRepo(worktreePath);
  if (!mainRepo) {
    socket.end(JSON.stringify({ error: "cannot resolve main repo from worktree" }) + "\n");
    return;
  }
  const parentBranch = detectParentBranch(mainRepo);
  if (!parentBranch) {
    socket.end(JSON.stringify({ error: "no master/main branch found" }) + "\n");
    return;
  }

  socket.write(JSON.stringify({ ok: true, watching: parentBranch }) + "\n");

  const mainGitDir = join(mainRepo, ".git");
  const refsHeadsDir = join(mainGitDir, "refs", "heads");
  const reftableDir = join(mainGitDir, "reftable");
  // eslint-disable-next-line functional/no-let -- mutable timer ref for debounced notify; no pure alternative for setTimeout handles
  let debounce: ReturnType<typeof setTimeout> | null = null;

  const notify = () => {
    if (debounce) return;
    debounce = setTimeout(() => {
      debounce = null;
      if (!socket.destroyed) socket.write(JSON.stringify({ event: "ref-change" }) + "\n");
    }, 100);
  };

  const makeWatcher = (target: string, filter?: (f: string | null) => boolean): FSWatcher | null => {
    try {
      return watch(target, (_type, filename) => {
        if (!filter || filter(filename)) notify();
      });
    } catch { return null; }
  };

  const worktreeBranch = syncReadWorktreeBranch(worktreePath);
  const rawWatchers = [
    makeWatcher(refsHeadsDir, (f) => f === parentBranch),
  ...(worktreeBranch ? [
      // Watch without filename filter — the branch name changes after /rename-branch,
      // so a filter on the original name would miss all subsequent commits.
      makeWatcher(join(refsHeadsDir, dirname(worktreeBranch))),
    ] : []),
    makeWatcher(mainGitDir, (f) => f === "packed-refs"),
    ...(existsSync(reftableDir) ? [makeWatcher(reftableDir)] : []),
  ];
  const watchers: FSWatcher[] = rawWatchers.filter((w): w is FSWatcher => w !== null);

  if (rawWatchers.length > 0 && watchers.length === 0) {
    // All watcher setups failed — tell the client so it can tighten its poll interval
    socket.write(JSON.stringify({ watchDegraded: true }) + "\n");
  }

  const cleanup = () => {
    watchers.forEach(w => { try { w.close(); } catch { /* */ } });
    if (debounce) { clearTimeout(debounce); debounce = null; }
  };
  socket.once("close", cleanup);
  socket.once("error", cleanup);
};
