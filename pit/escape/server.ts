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
 *     Response: { "ok": true, "watching": "master" }
 *     Push:     { "event": "ref-change" }
 *     Error:    { "error": "..." }
 *
 *   Check if worktree branch is merged to parent:
 *     Request:  { "op": "is-merged" }
 *     Response: { "merged": true, "branch": "pi/abc", "parentBranch": "master", "aheadCount": 0, "behindCount": 0 }
 *
 *   Refresh filtered settings:
 *     Request:  { "op": "refresh-settings" }
 *     Response: { "ok": true } | { "error": "reason" }
 *
 *   Error response: { "error": "reason" }
 */

import { createServer, type Server } from "node:net";
import type { Socket } from "node:net";
import { existsSync, readFileSync, statSync, unlinkSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Chunk from "effect/Chunk";
import { make as makeCommand, start as startCommand, workingDirectory as commandWorkingDirectory } from "@effect/platform/Command";
import { FileSystem } from "@effect/platform/FileSystem";
import { layer as NodeContextLayer, type NodeContext } from "@effect/platform-node/NodeContext";
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
  "add", "commit", "diff", "log", "merge",
  "rebase", "reset", "show", "stash", "status",
]);

// ── helpers ───────────────────────────────────────────────────────────────────

type GitResult = { stdout: string; stderr: string; code: number };

/**
 * Run a git command and capture stdout, stderr, and exit code.
 * R = NodeContext (CommandExecutor for the subprocess, FileSystem for Process streams).
 * Absorbs all failures into { code: 1 } so op handlers always succeed.
 */
const gitEffect = (
  args: string[],
  cwd: string,
): Effect.Effect<GitResult, never, NodeContext> =>
  Effect.scoped(
    Effect.gen(function* () {
      const proc = yield* startCommand(
        commandWorkingDirectory(makeCommand("git", ...args), cwd),
      );
      const decoder = new TextDecoder("utf8");
      const [stdoutChunks, stderrChunks, code] = yield* Effect.all([
        Stream.runCollect(proc.stdout),
        Stream.runCollect(proc.stderr),
        proc.exitCode,
      ]);
      return {
        stdout: Chunk.toReadonlyArray(stdoutChunks)
          .map((c) => decoder.decode(c))
          .join(""),
        stderr: Chunk.toReadonlyArray(stderrChunks)
          .map((c) => decoder.decode(c))
          .join(""),
        code: Number(code),
      };
    }),
  ).pipe(
    Effect.catchAll(() => Effect.succeed({ stdout: "", stderr: "", code: 1 })),
  );

const worktreeGit = (
  args: string[],
): Effect.Effect<GitResult, never, NodeContext> =>
  gitEffect(args, worktreePath);

/**
 * Detect the parent branch (master or main) in a repo.
 * Kept as a plain sync helper — only called from Effect.sync wrappers.
 */
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

const opGetState = (): Effect.Effect<
  object,
  never,
  NodeContext
> =>
  Effect.gen(function* () {
    const branch = yield* readWorktreeBranch(worktreePath);
    const mainRepo = yield* resolveMainRepo(worktreePath);
    const parentBranch = mainRepo
      ? yield* Effect.sync(() => detectParentBranch(mainRepo))
      : null;

    const gitdir = yield* readWorktreeGitdir(worktreePath);
    const mergeInProgress = gitdir
      ? existsSync(join(gitdir, "MERGE_HEAD"))
      : false;

    let conflicts: string[] = [];
    if (mergeInProgress) {
      const r = yield* worktreeGit(["diff", "--name-only", "--diff-filter=U"]);
      conflicts = r.stdout.trim().split("\n").filter(Boolean);
    }

    let behindParent = false;
    if (parentBranch && mainRepo) {
      const r = yield* worktreeGit(["log", "--oneline", `HEAD..${parentBranch}`]);
      behindParent = r.stdout.trim().length > 0;
    }

    return { branch, mergeInProgress, conflicts, parentBranch, behindParent };
  });

const opMergeToParent = (
  parentBranch: string,
): Effect.Effect<object, never, NodeContext> =>
  Effect.gen(function* () {
    const mainRepo = yield* resolveMainRepo(worktreePath);
    if (!mainRepo) return { error: "Cannot resolve main repo from worktree" };

    const branch = yield* readWorktreeBranch(worktreePath);
    if (!branch) return { error: "Cannot determine current branch (detached HEAD?)" };

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

const opRefreshSettings = (): Effect.Effect<
  object,
  never,
  FileSystem
> =>
  Effect.gen(function* () {
    const config = yield* readPitConfig(pitDir);
    return yield* writeFilteredSettings(agentDir, config, hostSettingsPath).pipe(
      Effect.map(() => ({ ok: true }) as object),
      Effect.catchAll((e) => Effect.succeed({ error: e.message })),
    );
  });

const opLocDiff = (): Effect.Effect<
  object,
  never,
  NodeContext
> =>
  Effect.gen(function* () {
    const branch = yield* readWorktreeBranch(worktreePath);
    const mainRepo = yield* resolveMainRepo(worktreePath);
    if (!branch || !mainRepo) {
      return { insertions: 0, deletions: 0, parentBranch: null };
    }
    const parentBranch = yield* Effect.sync(() => detectParentBranch(mainRepo));
    if (!parentBranch) {
      return { insertions: 0, deletions: 0, parentBranch: null };
    }
    const baseR = yield* worktreeGit(["merge-base", "HEAD", parentBranch]);
    const base = baseR.stdout.trim();
    if (!base) return { insertions: 0, deletions: 0, parentBranch };
    const diffR = yield* worktreeGit(["diff", "--shortstat", base]);
    const text = diffR.stdout.trim();
    const insMatch = text.match(/(\d+) insertion/);
    const delMatch = text.match(/(\d+) deletion/);
    const insertions = insMatch ? parseInt(insMatch[1], 10) : 0;
    const deletions = delMatch ? parseInt(delMatch[1], 10) : 0;
    return { insertions, deletions, parentBranch };
  });

const opIsMerged = (): Effect.Effect<
  object,
  never,
  NodeContext
> =>
  Effect.gen(function* () {
    const branch = yield* readWorktreeBranch(worktreePath);
    const mainRepo = yield* resolveMainRepo(worktreePath);
    if (!branch || !mainRepo) {
      return { merged: false, branch: branch ?? null, parentBranch: null, aheadCount: 0, behindCount: 0 };
    }
    const parentBranch = yield* Effect.sync(() => detectParentBranch(mainRepo));
    if (!parentBranch) {
      return { merged: false, branch, parentBranch: null, aheadCount: 0, behindCount: 0 };
    }
    const [mr, countR, behindR] = yield* Effect.all([
      gitEffect(["merge-base", "--is-ancestor", branch, parentBranch], mainRepo),
      worktreeGit(["rev-list", "--count", `${parentBranch}..HEAD`]),
      worktreeGit(["rev-list", "--count", `HEAD..${parentBranch}`]),
    ]);
    const aheadCount = parseInt(countR.stdout.trim(), 10) || 0;
    const behindCount = parseInt(behindR.stdout.trim(), 10) || 0;
    return { merged: mr.code === 0, branch, parentBranch, aheadCount, behindCount };
  });

// ── request dispatch ──────────────────────────────────────────────────────────

type Request = {
  op?: string;
  args?: unknown;
  parentBranch?: string;
  newBranch?: string;
};

const dispatchEffect = (
  req: Request,
): Effect.Effect<{ result: object; keepOpen: boolean }, never, NodeContext> =>
  Effect.gen(function* () {
    switch (req.op) {
      case "git": {
        const args = req.args;
        if (!Array.isArray(args) || args.length === 0 || typeof args[0] !== "string") {
          return { result: { error: "git op requires args (string[])" }, keepOpen: false };
        }
        const [sub, ...rest] = args as string[];
        if (!GIT_ALLOWED.has(sub)) {
          return {
            result: { error: `git ${sub}: not permitted. Allowed: ${[...GIT_ALLOWED].join(", ")}` },
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
      case "loc-diff":
        return { result: yield* opLocDiff(), keepOpen: false };
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
      case "subscribe":
        return { result: {}, keepOpen: true };
      default:
        return { result: { error: `Unknown op: ${req.op}` }, keepOpen: false };
    }
  });

// ── subscribe handler ─────────────────────────────────────────────────────────

/**
 * Set up a persistent subscription on a socket for parent branch ref changes.
 * Kept fully imperative — watch push events are callback-driven.
 * Uses sync fs calls directly (not FileSystem service) to avoid async in callbacks.
 */
function handleSubscribe(socket: Socket): void {
  // Sync helpers for use in this imperative context
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
  const watchers: FSWatcher[] = [];
  let debounce: ReturnType<typeof setTimeout> | null = null;

  const notify = () => {
    if (debounce) return;
    debounce = setTimeout(() => {
      debounce = null;
      if (!socket.destroyed) socket.write(JSON.stringify({ event: "ref-change" }) + "\n");
    }, 100);
  };

  const tryWatch = (target: string, filter?: (f: string | null) => boolean) => {
    try {
      watchers.push(watch(target, (_type, filename) => {
        if (!filter || filter(filename)) notify();
      }));
    } catch { /* target absent or unwatchable */ }
  };

  tryWatch(refsHeadsDir, (f) => f === parentBranch);
  const worktreeBranch = syncReadWorktreeBranch(worktreePath);
  if (worktreeBranch) {
    const branchRefDir = join(refsHeadsDir, dirname(worktreeBranch));
    const branchLeaf = basename(worktreeBranch);
    tryWatch(branchRefDir, (f) => f === branchLeaf);
  }
  tryWatch(mainGitDir, (f) => f === "packed-refs");
  if (existsSync(reftableDir)) tryWatch(reftableDir);

  const cleanup = () => {
    for (const w of watchers) { try { w.close(); } catch { /* */ } }
    watchers.length = 0;
    if (debounce) { clearTimeout(debounce); debounce = null; }
  };
  socket.once("close", cleanup);
  socket.once("error", cleanup);
}

// ── server ────────────────────────────────────────────────────────────────────

function cleanup() {
  server.close();
  try { unlinkSync(socketPath); } catch { /* already gone */ }
  process.exit(0);
}
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);

const server = createServer((socket) => {
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
      socket.end(JSON.stringify({ error: "request must have op (string)" }) + "\n");
      return;
    }

    if (req.op === "subscribe") {
      handleSubscribe(socket);
      return;
    }

    void Effect.runPromise(
      dispatchEffect(req).pipe(Effect.provide(NodeContextLayer)),
    ).then(({ result, keepOpen }) => {
      if (!keepOpen) socket.end(JSON.stringify(result) + "\n");
    });
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
