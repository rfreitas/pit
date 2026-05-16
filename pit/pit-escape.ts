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

/**
 * Resolve the main repo root from the worktree's .git pointer file.
 * worktree/.git → gitdir: <mainRepo>/.git/worktrees/<id>
 */
function resolveMainRepo(): string | null {
  try {
    const gitFile = path.join(worktreePath, ".git");
    if (fs.statSync(gitFile).isDirectory()) return null;
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
  const branch = getCurrentBranch();
  const mainRepo = resolveMainRepo();
  const parentBranch = mainRepo ? detectParentBranch(mainRepo) : null;

  const worktreeGitDir = resolveWorktreeGitDir();
  const mergeInProgress = worktreeGitDir
    ? fs.existsSync(path.join(worktreeGitDir, "MERGE_HEAD"))
    : false;

  let conflicts: string[] = [];
  if (mergeInProgress) {
    const r = await git(["diff", "--name-only", "--diff-filter=U"], worktreePath);
    conflicts = r.stdout.trim().split("\n").filter(Boolean);
  }

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
    // Read current host settings
    const rawSettings = fs.readFileSync(path.join(agentDir, "settings.json"), "utf8");
    const settings = JSON.parse(rawSettings) as { packages?: string[] };

    // Read pit config denylist (absent = no filtering)
    let denyPackages: string[] = [];
    const configPath = path.join(pitDir, "config.json");
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
        denyPackages?: string[];
      };
      denyPackages = config.denyPackages ?? [];
    }

    // Filter and write
    const filtered = {
      ...settings,
      packages: (settings.packages ?? []).filter((p) => !denyPackages.includes(p)),
    };

    fs.mkdirSync(path.dirname(hostSettingsPath), { recursive: true });
    fs.writeFileSync(hostSettingsPath, JSON.stringify(filtered, null, 2) + "\n");

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

    let req: { op?: string; args?: unknown; parentBranch?: string };
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
      let result: object;

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
          result = await new Promise((resolve) => {
            execFile("git", [sub, ...rest], { cwd: worktreePath }, (err, stdout, stderr) => {
              const code = err ? (Number((err as NodeJS.ErrnoException).code) || 1) : 0;
              resolve({ stdout, stderr, code });
            });
          });
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

        case "refresh-settings":
          result = opRefreshSettings();
          break;

        default:
          result = { error: `Unknown op: ${req.op}` };
      }

      socket.end(JSON.stringify(result) + "\n");
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
