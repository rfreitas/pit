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

  const makeWatcher = (
    target: string,
    filter?: (f: string | null) => boolean,
  ): FSWatcher | null => {
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
    if (!branch) { branchWatcher = null; return; }
    // Record the branch ref mtime at setup time. On macOS (FSEvents), creating
    // a worktree causes a delayed event for refs/heads/pi/<branch> to arrive
    // AFTER the watcher is registered. By snapshotting the mtime now, we can
    // suppress that initial event and only notify on genuine future changes.
    const branchFile = join(refsHeadsDir, branch);
    let setupMtime: number;
    try { setupMtime = statSync(branchFile).mtimeMs; } catch { setupMtime = 0; }
    branchWatcher = makeWatcher(
      join(refsHeadsDir, dirname(branch)),
      (f) => {
        if (f !== null && f !== basename(branch)) return false;
        // Suppress the initial FSEvents delivery of the watcher-setup file state
        try { return statSync(branchFile).mtimeMs !== setupMtime; }
        catch { return true; } // file deleted or renamed — that's a real change
      },
    );
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

  // ── index watcher — detects staged changes (git add / git reset / git commit) ──
  //
  // Watches the git index file directly. This covers changes that git diff
  // --numstat won't see: adding gitignored files, renaming staged files, etc.
  //
  // On macOS, git diff --numstat performs a stat refresh that causes FSEvents
  // to deliver an index change event ~100–200ms after the poll completes.
  //
  // A stat refresh does NOT change staged content — it only updates cached
  // file metadata (ctime, mtime, size) in the index. A real git add / git
  // reset DOES change staged content and shows a different `git diff --cached
  // --numstat` output. By running that command in the callback and comparing
  // against the last known staged diff, we distinguish real staging operations
  // from poll-induced stat refreshes without any timing-based suppression.

  const indexPath = worktreeGitdir ? join(worktreeGitdir, "index") : null;
  const readStagedHash = (): string => {
    try {
      return execFileSync("git", ["diff", "--cached", "--numstat"], {
        cwd: worktreePath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch { return ""; }
  };

  // Seed the staged hash at subscribe time so the first callback can compare.
  // Seeding BEFORE sending the ack ensures the snapshot reflects the repository
  // state BEFORE the subscriber has a chance to make changes.
  let lastStagedHash = readStagedHash();

  const indexWatcher: FSWatcher | null = indexPath
    ? makeWatcher(indexPath, () => {
        const current = readStagedHash();
        if (current === lastStagedHash) return false; // stat refresh only — suppress
        lastStagedHash = current;
        return true; // real staging change — notify
      })
    : null;

  // ── poll for unstaged changes ─────────────────────────────────────────────
  //
  // fs.watch on the worktree itself would risk ENOSPC on large repos.
  // Instead, run a cheap git diff --numstat on a configurable interval.
  // Only pushes ref-change when the output differs from the last known
  // state — idle polls are silent.

  const pollMs = Math.max(
    100,
    parseInt(process.env.PIT_ESCAPE_POLL_MS ?? "2000", 10) || 2000,
  );

  // Seed the poll hash BEFORE sending the ack. In a multi-process environment,
  // the client can receive the ack and start modifying the repository before
  // the server processes the next line of handleSubscribe. Seeding first
  // ensures the baseline captures the repo state at subscription time, so any
  // change made AFTER the ack is guaranteed to produce a different hash.
  let lastHash = execFileSync("git", ["diff", "--numstat"], {
    cwd: worktreePath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  // Now send the ack. The client is unblocked only after both seeds have run,
  // so any modification it makes thereafter will be detected by the first poll.
  socket.write(JSON.stringify({ ok: true, watching: parentBranch }) + "\n");

  const pollChanges = (): void => {
    try {
      const out = execFileSync("git", ["diff", "--numstat"], {
        cwd: worktreePath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (out !== lastHash) {
        lastHash = out;
        notify();
      }
    } catch { /* ignore errors during teardown */ }
  };

  const pollTimer = setInterval(pollChanges, pollMs);

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
