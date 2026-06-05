/**
 * Main program Effect for pit — worktree routing and session management.
 */

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { layer as NodeContextLayer, type NodeContext } from "./node-context.ts";
import { main } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { AGENT_DIR, PIT_DIR } from "./core/constants.ts";
import { parseFlags } from "./core/worktree/pure.ts";
import { worktreeCheckEffect, createFreshWorktreeEffect } from "./core/worktree/io.ts";
import { systemPromptArgs } from "./core/session/pure.ts";
import { setupNewSession, findOrCreateLinkedSession, refreshPitBranchIfStale } from "./core/session/io.ts";
import { readPitConfig } from "./core/sandbox/io.ts";
import { readWorktreeBranch, isLinkedWorktree } from "./core/git/utils.ts";
import {
  launchEffect,
  resolveSandboxMountsEffect,
  startPitEscapeEffect,
  type EscapeHandle,
} from "./launcher.ts";
import { setPitEscapeSocket } from "./env.ts";
import { SocketAliveError } from "./errors.ts";
import { spawnSync } from "node:child_process";
import { showPicker, showBranchDeletedPrompt } from "./picker.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Start pit-escape, register the socket path in env, and return the handle.
 * Returns undefined when not applicable (main worktree, etc.).
 */
const applyEscapeEffect = (
  cwd: string,
  sessionId: string,
): Effect.Effect<EscapeHandle | undefined, SocketAliveError, NodeContext> =>
  Effect.gen(function* () {
    const opt = yield* startPitEscapeEffect(cwd, sessionId);
    if (Option.isSome(opt)) setPitEscapeSocket(opt.value.socketPath);
    return Option.getOrUndefined(opt);
  });

// ── constants ─────────────────────────────────────────────────────────────────

const PI_SUBCOMMANDS = new Set([
  "install", "remove", "uninstall", "update", "list", "config",
]);
const INFO_ONLY_FLAGS = new Set([
  "-h", "--help", "-v", "--version", "--list-models", "--export",
]);
const SESSION_FLAGS = new Set([
  "-c", "--continue", "--session", "--no-session", "--fork",
]);

// ── dispatch ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

export const program = Effect.gen(function* () {
  const { sandbox, noTree, filteredArgv } = parseFlags(argv);
  const pitConfig = yield* readPitConfig(PIT_DIR);

  if (filteredArgv.length > 0 && PI_SUBCOMMANDS.has(filteredArgv[0])) {
    const r = spawnSync("pi", filteredArgv, { stdio: "inherit", shell: false });
    process.exit(r.status ?? 0);
  }

  if (filteredArgv.some((f) => INFO_ONLY_FLAGS.has(f))) {
    yield* launchEffect(process.cwd(), filteredArgv, false);
    return;
  }

  // ── pit -r: worktree-aware resume picker ─────────────────────────────────
  if (filteredArgv[0] === "-r" || filteredArgv[0] === "--resume") {
    const piArgs = filteredArgv.slice(1);
    const picked = yield* Effect.promise(() => showPicker(piArgs, sandbox));
    if (!picked) return;

    // Refresh cached branch in session file if it has drifted (e.g. branch renamed).
    // Runs before pi starts so there is no concurrent writer.
    if (picked.meta.branch) {
      const freshBranch = yield* readWorktreeBranch(picked.sessionCwd);
      if (freshBranch && freshBranch !== picked.meta.branch) {
        yield* refreshPitBranchIfStale(picked.sessionFile, freshBranch);
      }
    }

    const result = yield* worktreeCheckEffect({ meta: picked.meta, cwd: picked.sessionCwd }).pipe(
      Effect.catchTag("WorktreeMissingError", (e) =>
        Effect.gen(function* () {
          const createFresh = yield* Effect.promise(() => showBranchDeletedPrompt(e.branch));
          if (!createFresh) {
            yield* Effect.logInfo("pit: aborted by user");
            process.exit(0);
          }
          yield* createFreshWorktreeEffect({ repo: picked.meta.repo, branch: e.branch, worktree: picked.sessionCwd });
          return { cwd: picked.sessionCwd, meta: picked.meta };
        })
      )
    );
    const sandboxMounts = yield* resolveSandboxMountsEffect(result.cwd, sandbox, pitConfig);
    const escape = yield* applyEscapeEffect(result.cwd, picked.sessionUUID);

    yield* launchEffect(
      result.cwd,
      ["--session", picked.sessionFile, ...systemPromptArgs(sandboxMounts), ...piArgs],
      sandbox, sandboxMounts, pitConfig, escape,
    );
    return;
  }

  const userManagingSession = filteredArgv.some((f) => SESSION_FLAGS.has(f));

  // ── already inside a linked worktree ─────────────────────────────────────
  const inLinkedWorktree = yield* isLinkedWorktree(process.cwd());
  if (!noTree && inLinkedWorktree) {
    const cwd = process.cwd();
    if (userManagingSession) {
      yield* launchEffect(cwd, filteredArgv, sandbox);
      return;
    }
    const sandboxMounts = yield* resolveSandboxMountsEffect(cwd, sandbox, pitConfig);
    const session = yield* findOrCreateLinkedSession(cwd, AGENT_DIR, sandboxMounts);
    if (session.kind === "new") {
    console.error("pit: already in a git worktree — no pit session found, running no-tree");
    }
    const sessionUUID2 = SessionManager.open(session.sessionFile).getSessionId();
    const escape2 = yield* applyEscapeEffect(cwd, sessionUUID2);

    yield* launchEffect(
      cwd,
      ["--session", session.sessionFile, ...systemPromptArgs(sandboxMounts), ...filteredArgv],
      sandbox, sandboxMounts, pitConfig, escape2,
    );
    return;
  }

  // ── new session ───────────────────────────────────────────────────────────
  const result = yield* worktreeCheckEffect(undefined, noTree);

  if (userManagingSession) {
    // Escape server still starts for sandboxed user-managed sessions.
    const escapeUM = yield* applyEscapeEffect(result.cwd, randomUUID());
    yield* launchEffect(result.cwd, filteredArgv, sandbox, undefined, pitConfig, escapeUM);
  } else {
    const sandboxMounts = yield* resolveSandboxMountsEffect(result.cwd, sandbox, pitConfig);
    const sessionFile = yield* setupNewSession(result, AGENT_DIR, sandboxMounts);
    const sessionUUID3 = SessionManager.open(sessionFile).getSessionId();
    const escape3 = yield* applyEscapeEffect(result.cwd, sessionUUID3);
    yield* launchEffect(result.cwd, [
      "--session", sessionFile,
      ...systemPromptArgs(sandboxMounts),
      ...filteredArgv,
    ], sandbox, sandboxMounts, pitConfig, escape3);
  }
});
