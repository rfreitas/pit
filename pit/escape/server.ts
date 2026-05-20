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
 *     Response: { "merged": true, "branch": "pi/abc", "parentBranch": "master", "aheadCount": 0, "behindCount": 0 }
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
import { Effect } from "effect";
import {
  resolveMainRepo,
  readWorktreeBranch,
  readWorktreeGitdir,
} from "../git/utils.ts";
import { readPitConfig, writeFilteredSettings } from "../sandbox/io.ts";

const [, , socketPath, worktreePath, agentDir, pitDir, hostSettingsPath] =
  process.argv;
if (!socketPath || !worktreePath || !agentDir || !pitDir || !hostSettingsPath) {
  process.stderr.write(
    "usage: pit-escape <socket-path> <worktree-path> <agent-dir> <pit-dir> <host-settings-path>\n",
  );
  process.exit(1);
}

const GIT_ALLOWED = new Set([
  "add",
  "commit",
  "diff",
  "log",
  "merge",
  "rebase",
  "reset",
  "show",
  "stash",
  "status",
]);

// ── helpers ───────────────────────────────────────────────────────────────────

type GitResult = { stdout: string; stderr: string; code: number };

const gitEffect = (
  args: string[],
  cwd: string,
): Effect.Effect<GitResult> =>
  Effect.async((resume) => {
    execFile("git", args, { cwd }, (err, stdout, stderr) => {
      const code = err
        ? Number((err as NodeJS.ErrnoException).code) || 1
        : 0;
      resume(Effect.succeed({ stdout, stderr, code }));
    });
  });

// All agent-facing git operations run in the worktree — bound once here.
const worktreeGit = (args: string[]): Effect.Effect<GitResult> =>
  gitEffect(args, worktreePath);

function detectParentBranch(mainRepo: string): string | null {
  for (const candidate of ["master", "main"]) {
    try {
      execFileSync("git", ["rev-parse", "--verify", candidate], {
        cwd: mainRepo,
        stdio: "ignore",
      });
      return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

// ── ops ───────────────────────────────────────────────────────────────────────

const opGetState = (): Effect.Effect<object> =>
  Effect.gen(function* () {
    const branch = readWorktreeBranch(worktreePath);
    const mainRepo = resolveMainRepo(worktreePath);
    const parentBranch = mainRepo ? detectParentBranch(mainRepo) : null;

    const gitdir = readWorktreeGitdir(worktreePath);
    const mergeInProgress = gitdir
      ? fs.existsSync(path.join(gitdir, "MERGE_HEAD"))
      : false;

    let conflicts: string[] = [];
    if (mergeInProgress) {
      const r = yield* worktreeGit([
        "diff",
        "--name-only",
        "--diff-filter=U",
      ]);
      conflicts = r.stdout.trim().split("\n").filter(Boolean);
    }

    let behindParent = false;
    if (parentBranch && mainRepo) {
      const r = yield* worktreeGit([
        "log",
        "--oneline",
        `HEAD..${parentBranch}`,
      ]);
      behindParent = r.stdout.trim().length > 0;
    }

    return { branch, mergeInProgress, conflicts, parentBranch, behindParent };
  });

const opMergeToParent = (parentBranch: string): Effect.Effect<object, never, never> =>
  Effect.gen(function* () {
    const mainRepo = resolveMainRepo(worktreePath);
    if (!mainRepo)
      return { error: "Cannot resolve main repo from worktree" };

    const branch = readWorktreeBranch(worktreePath);
    if (!branch)
      return { error: "Cannot determine current branch (detached HEAD?)" };

    // Read main repo HEAD — catch synchronously, return as error object
    let checkedOut: string;
    try {
      checkedOut = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: mainRepo,
        encoding: "utf8",
      }).trim();
    } catch (e) {
      return { error: `Cannot read main repo HEAD: ${(e as Error).message}` };
    }

    if (checkedOut !== parentBranch) {
      return {
        error: `Main repo has '${checkedOut}' checked out, not '${parentBranch}'. Check out '${parentBranch}' first.`,
      };
    }

    return yield* gitEffect(["merge", "--ff-only", branch], mainRepo);
  });

const opRefreshSettings = (): Effect.Effect<object, never, never> =>
  Effect.sync((): object => {
    try {
      writeFilteredSettings(agentDir, readPitConfig(pitDir), hostSettingsPath);
      return { ok: true };
    } catch (e) {
      return { error: (e as Error).message };
    }
  });

const opIsMerged = (): Effect.Effect<object> =>
  Effect.gen(function* () {
    const branch = readWorktreeBranch(worktreePath);
    const mainRepo = resolveMainRepo(worktreePath);
    if (!branch || !mainRepo) {
      return {
        merged: false,
        branch: branch ?? null,
        parentBranch: null,
        aheadCount: 0,
        behindCount: 0,
      };
    }
    const parentBranch = detectParentBranch(mainRepo);
    if (!parentBranch) {
      return {
        merged: false,
        branch,
        parentBranch: null,
        aheadCount: 0,
        behindCount: 0,
      };
    }
    const mr = yield* gitEffect(
      ["merge-base", "--is-ancestor", branch, parentBranch],
      mainRepo,
    );
    const countR = yield* worktreeGit([
      "rev-list",
      "--count",
      `${parentBranch}..HEAD`,
    ]);
    const aheadCount = parseInt(countR.stdout.trim(), 10) || 0;
    const behindR = yield* worktreeGit([
      "rev-list",
      "--count",
      `HEAD..${parentBranch}`,
    ]);
    const behindCount = parseInt(behindR.stdout.trim(), 10) || 0;
    return {
      merged: mr.code === 0,
      branch,
      parentBranch,
      aheadCount,
      behindCount,
    };
  });

// ── request dispatch ──────────────────────────────────────────────────────────

type Request = {
  op?: string;
  args?: unknown;
  parentBranch?: string;
  newBranch?: string;
};

/**
 * Dispatch a parsed request to the appropriate op Effect.
 * Returns [result, keepOpen] — keepOpen=true for the subscribe op.
 */
const dispatchEffect = (
  req: Request,
): Effect.Effect<{ result: object; keepOpen: boolean }> =>
  Effect.gen(function* () {
    switch (req.op) {
      case "git": {
        const args = req.args;
        if (
          !Array.isArray(args) ||
          args.length === 0 ||
          typeof args[0] !== "string"
        ) {
          return { result: { error: "git op requires args (string[])" }, keepOpen: false };
        }
        const [sub, ...rest] = args as string[];
        if (!GIT_ALLOWED.has(sub)) {
          return {
            result: {
              error: `git ${sub}: not permitted. Allowed: ${[...GIT_ALLOWED].join(", ")}`,
            },
            keepOpen: false,
          };
        }
        return { result: yield* worktreeGit([sub, ...rest]), keepOpen: false };
      }

      case "get-state":
        return { result: yield* opGetState(), keepOpen: false };

      case "merge-to-parent":
        if (!req.parentBranch) {
          return { result: { error: "merge-to-parent requires parentBranch" }, keepOpen: false };
        }
        return { result: yield* opMergeToParent(req.parentBranch), keepOpen: false };

      case "is-merged":
        return { result: yield* opIsMerged(), keepOpen: false };

      case "refresh-settings":
        return { result: yield* opRefreshSettings(), keepOpen: false };

      case "rename-branch": {
        const { newBranch } = req;
        if (!newBranch || typeof newBranch !== "string") {
          return { result: { error: "rename-branch requires newBranch (string)" }, keepOpen: false };
        }
        return { result: yield* worktreeGit(["branch", "-m", newBranch]), keepOpen: false };
      }

      // subscribe is handled outside Effect (imperative fs.watch + socket push)
      case "subscribe":
        return { result: {}, keepOpen: true };

      default:
        return { result: { error: `Unknown op: ${req.op}` }, keepOpen: false };
    }
  });

// ── subscribe handler ─────────────────────────────────────────────────────────

/**
 * Set up a persistent subscription on a socket for parent branch ref changes.
 * Calls notify() on every detected ref change, cleans up when socket closes.
 * This is intentionally kept as imperative Node.js — fs.watch events are
 * inherently callback-driven and don't benefit from Effect wrapping here.
 */
function handleSubscribe(socket: net.Socket): void {
  const mainRepo = resolveMainRepo(worktreePath);
  if (!mainRepo) {
    socket.end(
      JSON.stringify({ error: "cannot resolve main repo from worktree" }) +
        "\n",
    );
    return;
  }
  const parentBranch = detectParentBranch(mainRepo);
  if (!parentBranch) {
    socket.end(
      JSON.stringify({ error: "no master/main branch found" }) + "\n",
    );
    return;
  }

  socket.write(JSON.stringify({ ok: true, watching: parentBranch }) + "\n");

  const mainGitDir = path.join(mainRepo, ".git");
  const refsHeadsDir = path.join(mainGitDir, "refs", "heads");
  const reftableDir = path.join(mainGitDir, "reftable");
  const watchers: fs.FSWatcher[] = [];
  let debounce: ReturnType<typeof setTimeout> | null = null;

  const notify = () => {
    if (debounce) return;
    debounce = setTimeout(() => {
      debounce = null;
      if (!socket.destroyed)
        socket.write(JSON.stringify({ event: "ref-change" }) + "\n");
    }, 100);
  };

  const tryWatch = (
    target: string,
    filter?: (f: string | null) => boolean,
  ) => {
    try {
      watchers.push(
        fs.watch(target, (_type, filename) => {
          if (!filter || filter(filename)) notify();
        }),
      );
    } catch {
      /* target absent or unwatchable */
    }
  };

  tryWatch(refsHeadsDir, (f) => f === parentBranch);
  const worktreeBranch = readWorktreeBranch(worktreePath);
  if (worktreeBranch) {
    const branchRefDir = path.join(refsHeadsDir, path.dirname(worktreeBranch));
    const branchLeaf = path.basename(worktreeBranch);
    tryWatch(branchRefDir, (f) => f === branchLeaf);
  }
  tryWatch(mainGitDir, (f) => f === "packed-refs");
  if (fs.existsSync(reftableDir)) tryWatch(reftableDir);

  const cleanup = () => {
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        /* */
      }
    }
    watchers.length = 0;
    if (debounce) {
      clearTimeout(debounce);
      debounce = null;
    }
  };

  socket.once("close", cleanup);
  socket.once("error", cleanup);
}

// ── server ────────────────────────────────────────────────────────────────────

function cleanup() {
  server.close();
  try {
    fs.unlinkSync(socketPath);
  } catch {
    /* already gone */
  }
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

    let req: Request;
    try {
      req = JSON.parse(line) as Request;
    } catch {
      socket.end(JSON.stringify({ error: "invalid JSON" }) + "\n");
      return;
    }

    if (typeof req.op !== "string") {
      socket.end(
        JSON.stringify({ error: "request must have op (string)" }) + "\n",
      );
      return;
    }

    if (req.op === "subscribe") {
      handleSubscribe(socket);
      return;
    }

    void Effect.runPromise(dispatchEffect(req)).then(({ result, keepOpen }) => {
      if (!keepOpen) socket.end(JSON.stringify(result) + "\n");
    });
  });

  socket.on("error", () => {
    /* ignore client disconnect errors */
  });
});

server.listen(socketPath, () => {
  process.stdout.write("ready\n");
});

server.on("error", (err: Error) => {
  process.stderr.write(`pit-escape: ${err.message}\n`);
  process.exit(1);
});
