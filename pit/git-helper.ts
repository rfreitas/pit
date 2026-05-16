#!/usr/bin/env -S node --experimental-strip-types
/**
 * pit git helper — runs OUTSIDE the bwrap sandbox.
 *
 * Protocol (newline-delimited JSON, one request per connection):
 *
 *   Git command in worktree:
 *     Request:  { "args": ["commit", "-m", "message"] }
 *     Response: { "stdout": "...", "stderr": "...", "code": 0 }
 *
 *   Special operations:
 *     Request:  { "op": "get-state" }
 *     Response: { "branch": "pi/abc", "mergeInProgress": false, "conflicts": [],
 *                 "parentBranch": "master", "behindParent": false }
 *
 *     Request:  { "op": "merge-to-parent", "parentBranch": "master" }
 *     Response: { "stdout": "...", "stderr": "...", "code": 0 }
 *
 *   Error response: { "error": "reason" }
 *
 * Signals readiness to the parent by writing "ready\n" to stdout.
 * Cleans up the socket file on SIGTERM/SIGINT.
 */

import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile, execFileSync } from "node:child_process";

const [, , socketPath, worktreePath] = process.argv;
if (!socketPath || !worktreePath) {
  process.stderr.write("usage: git-helper <socket-path> <worktree-path>\n");
  process.exit(1);
}

const ALLOWED = new Set([
  "add", "commit", "diff", "log", "merge",
  "rebase", "reset", "show", "stash", "status",
]);

// ── helpers ───────────────────────────────────────────────────────────────────

function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd }, (err, stdout, stderr) => {
      const code = err ? (Number((err as NodeJS.ErrnoException).code) || 1) : 0;
      resolve({ stdout, stderr, code });
    });
  });
}

/**
 * Resolve the main repo root from the worktree's .git pointer file.
 * worktree/.git → gitdir: <mainRepo>/.git/worktrees/<id>
 * So mainRepo = gitdir/../../..
 */
function resolveMainRepo(): string | null {
  try {
    const gitFile = path.join(worktreePath, ".git");
    if (fs.statSync(gitFile).isDirectory()) return null; // main worktree
    const worktreeGitDir = fs.readFileSync(gitFile, "utf8").trim().replace(/^gitdir:\s*/, "");
    return path.resolve(worktreeGitDir, "../../..");
  } catch {
    return null;
  }
}

function resolveWorktreeGitDir(): string | null {
  try {
    const gitFile = path.join(worktreePath, ".git");
    if (fs.statSync(gitFile).isDirectory()) return null;
    return fs.readFileSync(gitFile, "utf8").trim().replace(/^gitdir:\s*/, "");
  } catch {
    return null;
  }
}

function getCurrentBranch(): string | null {
  const worktreeGitDir = resolveWorktreeGitDir();
  if (!worktreeGitDir) return null;
  try {
    const head = fs.readFileSync(path.join(worktreeGitDir, "HEAD"), "utf8").trim();
    const m = head.match(/^ref: refs\/heads\/(.+)$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function detectParentBranch(mainRepo: string): string | null {
  for (const candidate of ["master", "main"]) {
    try {
      execFileSync("git", ["rev-parse", "--verify", candidate], { cwd: mainRepo, stdio: "ignore" });
      return candidate;
    } catch { /* try next */ }
  }
  return null;
}

// ── ops ───────────────────────────────────────────────────────────────────────

async function opGetState(): Promise<object> {
  const branch = getCurrentBranch();
  const mainRepo = resolveMainRepo();
  const parentBranch = mainRepo ? detectParentBranch(mainRepo) : null;

  // Check if merge in progress (MERGE_HEAD file exists)
  const worktreeGitDir = resolveWorktreeGitDir();
  const mergeInProgress = worktreeGitDir
    ? fs.existsSync(path.join(worktreeGitDir, "MERGE_HEAD"))
    : false;

  // Conflicted files
  let conflicts: string[] = [];
  if (mergeInProgress) {
    const r = await git(["diff", "--name-only", "--diff-filter=U"], worktreePath);
    conflicts = r.stdout.trim().split("\n").filter(Boolean);
  }

  // Is worktree behind parent?
  let behindParent = false;
  if (parentBranch && mainRepo) {
    const r = await git(["log", "--oneline", `HEAD..${parentBranch}`], worktreePath);
    behindParent = r.stdout.trim().length > 0;
  }

  return { branch, mergeInProgress, conflicts, parentBranch, behindParent };
}

async function opMergeToParent(parentBranch: string): Promise<object> {
  const mainRepo = resolveMainRepo();
  if (!mainRepo) return { error: "Cannot resolve main repo from worktree" };

  const branch = getCurrentBranch();
  if (!branch) return { error: "Cannot determine current branch (detached HEAD?)" };

  // Fast-forward parent branch without checking it out
  return git(["fetch", ".", `${branch}:${parentBranch}`], mainRepo);
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

    let req: { args?: unknown; op?: string; parentBranch?: string };
    try { req = JSON.parse(line); } catch {
      socket.end(JSON.stringify({ error: "invalid JSON" }) + "\n");
      return;
    }

    // ── special ops ──────────────────────────────────────────────────────────
    if (typeof req.op === "string") {
      (async () => {
        let result: object;
        if (req.op === "get-state") {
          result = await opGetState();
        } else if (req.op === "merge-to-parent") {
          if (!req.parentBranch) { result = { error: "merge-to-parent requires parentBranch" }; }
          else { result = await opMergeToParent(req.parentBranch); }
        } else {
          result = { error: `Unknown op: ${req.op}` };
        }
        socket.end(JSON.stringify(result) + "\n");
      })();
      return;
    }

    // ── git args ─────────────────────────────────────────────────────────────
    if (!Array.isArray(req.args) || req.args.length === 0 || typeof req.args[0] !== "string") {
      socket.end(JSON.stringify({ error: "request must have args (string[]) or op (string)" }) + "\n");
      return;
    }

    const [sub, ...rest] = req.args as string[];
    if (!ALLOWED.has(sub)) {
      socket.end(JSON.stringify({ error: `git ${sub}: not permitted. Allowed: ${[...ALLOWED].join(", ")}` }) + "\n");
      return;
    }

    execFile("git", [sub, ...rest], { cwd: worktreePath }, (err, stdout, stderr) => {
      const code = err ? (Number((err as NodeJS.ErrnoException).code) || 1) : 0;
      socket.end(JSON.stringify({ stdout, stderr, code }) + "\n");
    });
  });

  socket.on("error", () => { /* ignore client disconnect errors */ });
});

server.listen(socketPath, () => {
  process.stdout.write("ready\n");
});

server.on("error", (err: Error) => {
  process.stderr.write(`pit git-helper: ${err.message}\n`);
  process.exit(1);
});
