#!/usr/bin/env -S node --experimental-strip-types
/**
 * pit-escape — out-of-sandbox helper for pit sessions.
 *
 * Runs OUTSIDE the bwrap sandbox with full host access.
 * Communicates with the sandboxed pi session via Unix socket.
 * Signals readiness by writing "ready\n" to stdout.
 *
 * Protocol (newline-delimited JSON, one request per connection):
 *
 * All ops use request/response except `subscribe`, which keeps the connection
 * open and pushes events until the client disconnects.
 *
 *   Git command in worktree:
 *     Request:  { "op": "git", "args": ["commit", "-m", "message"] }
 *     Response: { "stdout": "...", "stderr": "...", "code": 0 }
 *
 *   Get worktree state:
 *     Request:  { "op": "get-state" }
 *     Response: { "branch": "pi/abc", "mergeInProgress": false, "conflicts": [],
 *                 "parentBranch": "master", "behindParent": false }
 *
 *   Merge worktree branch to parent:
 *     Request:  { "op": "merge-to-parent", "parentBranch": "master" }
 *     Response: { "stdout": "...", "stderr": "...", "code": 0 }
 *
 *   Subscribe to parent branch ref changes (persistent connection):
 *     Request:  { "op": "subscribe" }
 *     Response: { "ok": true, "watching": "master" }   (ack, connection stays open)
 *     Push:     { "event": "ref-change" }              (on every parent branch update)
 *     Error:    { "error": "..." }                     (closes connection)
 *
 *   Check if worktree branch is merged to parent:
 *     Request:  { "op": "is-merged" }
 *     Response: { "merged": true, "branch": "pi/abc", "parentBranch": "master" }
 *
 *   Refresh filtered settings (re-read host settings + apply pit denylist):
 *     Request:  { "op": "refresh-settings" }
 *     Response: { "ok": true } | { "error": "reason" }
 *
 *   Error response: { "error": "reason" }
 */

import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { resolveMainRepo, readWorktreeBranch, readWorktreeGitdir } from "./git-utils.ts";
import { readPitConfig, writeFilteredSettings } from "./utils.ts";

const [, , socketPath, worktreePath, agentDir, pitDir, hostSettingsPath] = process.argv;
if (!socketPath || !worktreePath || !agentDir || !pitDir || !hostSettingsPath) {
  process.stderr.write(
    "usage: pit-escape <socket-path> <worktree-path> <agent-dir> <pit-dir> <host-settings-path>\n"
  );
  process.exit(1);
}

const GIT_ALLOWED = new Set([
  "add", "commit", "diff", "log", "merge",
  "rebase", "reset", "show", "stash", "status",
]);

// ── helpers ───────────────────────────────────────────────────────────────────

function git(
  args: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd }, (err, stdout, stderr) => {
      const code = err ? (Number((err as NodeJS.ErrnoException).code) || 1) : 0;
      resolve({ stdout, stderr, code });
    });
  });
}

// All agent-facing git operations run in the worktree — bound once here.
const worktreeGit = (args: string[]) => git(args, worktreePath);

function detectParentBranch(mainRepo: string): string | null {
  for (const candidate of ["master", "main"]) {
    try {
      execFileSync("git", ["rev-parse", "--verify", candidate], {
        cwd: mainRepo,
        stdio: "ignore",
      });
      return candidate;
    } catch { /* try next */ }
  }
  return null;
}

// ── ops ───────────────────────────────────────────────────────────────────────

async function opGetState(): Promise<object> {
  const branch = readWorktreeBranch(worktreePath);
  const mainRepo = resolveMainRepo(worktreePath);
  const parentBranch = mainRepo ? detectParentBranch(mainRepo) : null;

  const gitdir = readWorktreeGitdir(worktreePath);
  const mergeInProgress = gitdir
    ? fs.existsSync(path.join(gitdir, "MERGE_HEAD"))
    : false;

  let conflicts: string[] = [];
  if (mergeInProgress) {
    const r = await worktreeGit(["diff", "--name-only", "--diff-filter=U"]);
    conflicts = r.stdout.trim().split("\n").filter(Boolean);
  }

  let behindParent = false;
  if (parentBranch && mainRepo) {
    const r = await worktreeGit(["log", "--oneline", `HEAD..${parentBranch}`]);
    behindParent = r.stdout.trim().length > 0;
  }

  return { branch, mergeInProgress, conflicts, parentBranch, behindParent };
}

async function opMergeToParent(parentBranch: string): Promise<object> {
  const mainRepo = resolveMainRepo(worktreePath);
  if (!mainRepo) return { error: "Cannot resolve main repo from worktree" };

  const branch = readWorktreeBranch(worktreePath);
  if (!branch) return { error: "Cannot determine current branch (detached HEAD?)" };

  try {
    const checkedOut = execFileSync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: mainRepo, encoding: "utf8" }
    ).trim();
    if (checkedOut !== parentBranch) {
      return {
        error: `Main repo has '${checkedOut}' checked out, not '${parentBranch}'. Check out '${parentBranch}' first.`,
      };
    }
  } catch (e) {
    return { error: `Cannot read main repo HEAD: ${(e as Error).message}` };
  }

  return git(["merge", "--ff-only", branch], mainRepo);
}

/**
 * Re-read host settings.json, apply the pit config denylist, and write the
 * filtered result to hostSettingsPath. Called by the bundled reload extension
 * on session_shutdown with reason "reload" — before pi re-reads settings.
 */
function opRefreshSettings(): object {
  try {
    writeFilteredSettings(agentDir, readPitConfig(pitDir), hostSettingsPath);
    return { ok: true };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

// ── server ────────────────────────────────────────────────────────────────────

function cleanup() {
  server.close();
  try { fs.unlinkSync(socketPath); } catch { /* already gone */ }
  process.exit(0);
}
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);

const server = net.createServer((socket) => {
  let buf = "";

  socket.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    const nl = buf.indexOf("\n");
    if (nl === -1) return;
    const line = buf.slice(0, nl);
    buf = "";

    let req: { op?: string; args?: unknown; parentBranch?: string; newBranch?: string };
    try {
      req = JSON.parse(line);
    } catch {
      socket.end(JSON.stringify({ error: "invalid JSON" }) + "\n");
      return;
    }

    if (typeof req.op !== "string") {
      socket.end(
        JSON.stringify({ error: "request must have op (string)" }) + "\n"
      );
      return;
    }

    (async () => {
      let result: object | undefined;
      let keepOpen = false;

      switch (req.op) {
        case "git": {
          const args = req.args;
          if (!Array.isArray(args) || args.length === 0 || typeof args[0] !== "string") {
            result = { error: "git op requires args (string[])" };
            break;
          }
          const [sub, ...rest] = args as string[];
          if (!GIT_ALLOWED.has(sub)) {
            result = {
              error: `git ${sub}: not permitted. Allowed: ${[...GIT_ALLOWED].join(", ")}`,
            };
            break;
          }
          result = await worktreeGit([sub, ...rest]);
          break;
        }

        case "get-state":
          result = await opGetState();
          break;

        case "merge-to-parent":
          if (!req.parentBranch) {
            result = { error: "merge-to-parent requires parentBranch" };
          } else {
            result = await opMergeToParent(req.parentBranch);
          }
          break;

        case "subscribe": {
          keepOpen = true;
          const mainRepo = resolveMainRepo(worktreePath);
          if (!mainRepo) {
            socket.end(JSON.stringify({ error: "cannot resolve main repo from worktree" }) + "\n");
            break;
          }
          const parentBranch = detectParentBranch(mainRepo);
          if (!parentBranch) {
            socket.end(JSON.stringify({ error: "no master/main branch found" }) + "\n");
            break;
          }

          // Acknowledge: subscription active
          socket.write(JSON.stringify({ ok: true, watching: parentBranch }) + "\n");

          const mainGitDir = path.join(mainRepo, ".git");
          const refsHeadsDir = path.join(mainGitDir, "refs", "heads");
          const reftableDir = path.join(mainGitDir, "reftable");
          const watchers: import("node:fs").FSWatcher[] = [];
          let debounce: ReturnType<typeof setTimeout> | null = null;

          const notify = () => {
            if (debounce) return;
            debounce = setTimeout(() => {
              debounce = null;
              if (!socket.destroyed) socket.write(JSON.stringify({ event: "ref-change" }) + "\n");
            }, 100);
          };

          const tryWatch = (
            target: string,
            filter?: (f: string | null) => boolean
          ) => {
            try {
              watchers.push(fs.watch(target, (_type, filename) => {
                if (!filter || filter(filename)) notify();
              }));
            } catch { /* target absent or unwatchable */ }
          };

          // Loose ref: refs/heads/<parentBranch> updated on fast-forward
          tryWatch(refsHeadsDir, (f) => f === parentBranch);
          // Packed refs: watch .git dir for atomic rename of packed-refs
          tryWatch(mainGitDir, (f) => f === "packed-refs");
          // Reftable format: branch updates land in reftable/
          if (fs.existsSync(reftableDir)) tryWatch(reftableDir);

          const cleanup = () => {
            for (const w of watchers) { try { w.close(); } catch { /* */ } }
            watchers.length = 0;
            if (debounce) { clearTimeout(debounce); debounce = null; }
          };

          socket.once("close", cleanup);
          socket.once("error", cleanup);
          // Don't end the socket — keep it open for push events
          break;
        }

        case "is-merged": {
          const branch = readWorktreeBranch(worktreePath);
          const mainRepo = resolveMainRepo(worktreePath);
          if (!branch || !mainRepo) {
            result = { merged: false, branch: branch ?? null, parentBranch: null };
            break;
          }
          const parentBranch = detectParentBranch(mainRepo);
          if (!parentBranch) {
            result = { merged: false, branch, parentBranch: null };
            break;
          }
          // exit 0 = branch is an ancestor of parentBranch (i.e. merged)
          const mr = await git(["merge-base", "--is-ancestor", branch, parentBranch], mainRepo);
          result = { merged: mr.code === 0, branch, parentBranch };
          break;
        }

        case "refresh-settings":
          result = opRefreshSettings();
          break;

        case "rename-branch": {
          const { newBranch } = req;
          if (!newBranch || typeof newBranch !== "string") {
            result = { error: "rename-branch requires newBranch (string)" };
            break;
          }
          result = await worktreeGit(["branch", "-m", newBranch]);
          break;
        }

        default:
          result = { error: `Unknown op: ${req.op}` };
      }

      if (!keepOpen) socket.end(JSON.stringify(result!) + "\n");
    })();
  });

  socket.on("error", () => { /* ignore client disconnect errors */ });
});

server.listen(socketPath, () => {
  process.stdout.write("ready\n");
});

server.on("error", (err: Error) => {
  process.stderr.write(`pit-escape: ${err.message}\n`);
  process.exit(1);
});
