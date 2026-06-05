/**
 * subscribe op — persistent socket that pushes ref-change events.
 * Kept fully imperative: watch push events are callback-driven.
 * No display logic — errors propagate to the socket boundary (server.ts).
 */

import { existsSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { execFileSync } from "node:child_process";
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

  const syncReadWorktreeGitdir = (cwd: string): string | null => {
    try {
      const gitPath = join(cwd, ".git");
      if (statSync(gitPath).isDirectory()) return null;
      const gitdir = readFileSync(gitPath, "utf8").trim().replace(/^gitdir:\s*/, "");
      if (!gitdir.includes("/.git/worktrees/")) return null;
      return gitdir;
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
  const worktreeGitdir = syncReadWorktreeGitdir(worktreePath);

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
        // On Linux (inotify), filename is not guaranteed when watching a
        // directory — the kernel may coalesce events and drop the name.
        // When we can't identify the file, fire anyway: a false positive
        // is harmless (debounce coalesces bursts), but a missed event
        // breaks ref-change notifications for merges and renames.
        if (!filter || filename === null || filter(filename)) notify();
      });
    } catch { return null; }
  };

  // ── branch watcher — retargeted on rename ────────────────────────────────
  //
  // Watches the exact branch ref file. When the branch is renamed (HEAD
  // changes), the HEAD watcher below updates currentBranch and replaces this.

  let currentBranch = syncReadWorktreeBranch(worktreePath);
  let branchWatcher: FSWatcher | null = null;

  const setupBranchWatcher = (): void => {
    if (branchWatcher) { try { branchWatcher.close(); } catch { /* */ } }
    const branch = currentBranch; // capture: TS can't narrow a let inside a callback
    branchWatcher = branch
      ? makeWatcher(
          join(refsHeadsDir, dirname(branch)),
          (f) => f === basename(branch),
        )
      : null;
  };

  setupBranchWatcher();

  // ── HEAD watcher — detects rename ────────────────────────────────────────
  //
  // Watches the worktree-specific HEAD file. git branch -m updates this file,
  // which triggers a re-read of the branch name and a retarget of branchWatcher.

  const headWatcher = worktreeGitdir
    ? (() => {
        try {
          return watch(worktreeGitdir, (_type, filename) => {
            if (filename !== "HEAD") return;
            const newBranch = syncReadWorktreeBranch(worktreePath);
            if (newBranch !== currentBranch) {
              currentBranch = newBranch;
              setupBranchWatcher();
            }
            notify();
          });
        } catch { return null; }
      })()
    : null;

  // ── index watcher — detects staged changes ────────────────────────────
  //
  // Watches the git index file. git add / git reset / git commit all touch
  // this file, so a single watch covers all staged-change scenarios.

  const indexWatcher: FSWatcher | null = worktreeGitdir
    ? makeWatcher(join(worktreeGitdir, "index"))
    : null;

  // ── poll for unstaged changes ───────────────────────────────────────────
  //
  // fs.watch on the worktree itself would risk ENOSPC on large repos.
  // Instead, run a cheap git diff --numstat on a configurable interval.
  // Only pushes ref-change when the output differs from the last known
  // state — idle polls are silent.

  const pollMs = Math.max(
    100,
    parseInt(process.env.PIT_ESCAPE_POLL_MS ?? "2000", 10) || 2000,
  );
  let lastUnstagedHash = "";

  const pollUnstaged = (): void => {
    try {
      const out = execFileSync("git", ["diff", "--numstat"], {
        cwd: worktreePath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (out !== lastUnstagedHash) {
        lastUnstagedHash = out;
        notify();
      }
    } catch { /* ignore errors during teardown */ }
  };

  // Run the first poll synchronously to seed lastUnstagedHash
  pollUnstaged();
  const pollTimer = setInterval(pollUnstaged, pollMs);

  // ── static watchers ───────────────────────────────────────────────────────

  const staticWatchers = [
    makeWatcher(refsHeadsDir, (f) => f === parentBranch),
    makeWatcher(mainGitDir, (f) => f === "packed-refs"),
    ...(existsSync(reftableDir) ? [makeWatcher(reftableDir)] : []),
  ];

  const allWatchers = [
    ...staticWatchers, branchWatcher, headWatcher, indexWatcher,
  ].filter((w): w is FSWatcher => w !== null);

  if (allWatchers.length === 0) {
    socket.write(JSON.stringify({ watchDegraded: true }) + "\n");
  }

  const cleanup = () => {
    [...staticWatchers, branchWatcher, headWatcher, indexWatcher]
      .forEach(w => { if (w) { try { w.close(); } catch { /* */ } } });
    if (debounce) { clearTimeout(debounce); debounce = null; }
    clearInterval(pollTimer);
  };
  socket.once("close", cleanup);
  socket.once("error", cleanup);
};
