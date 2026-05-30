/**
 * Main program Effect for pit — worktree routing and session management.
 */

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { layer as NodeContextLayer, type NodeContext } from "@effect/platform-node/NodeContext";
import {
  main,
  SessionManager,
  SessionSelectorComponent,
  initTheme,
  type CustomEntry,
} from "@earendil-works/pi-coding-agent";
import { unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { PitMetadata, SandboxMounts } from "./types.ts";
import { AGENT_DIR, PIT_DIR } from "./core/constants.ts";
import { parseFlags } from "./core/worktree/pure.ts";
import { worktreeCheckEffect, type ExistingSession } from "./core/worktree/io.ts";
import { systemPromptArgs } from "./core/session/pure.ts";
import { setupNewSession, findOrCreateLinkedSession, refreshPitBranchIfStale } from "./core/session/io.ts";
import { readPitConfig, createTempSettingsFileEffect } from "./core/sandbox/io.ts";
import {
  isLinkedWorktree,
  resolveMainRepo,
  listRepoWorktrees,
  readWorktreeBranch,
  gitRepoRoot,
} from "./core/git/utils.ts";
import {
  launchEffect,
  resolveSandboxMountsEffect,
  startPitEscapeEffect,
  type EscapeHandle,
} from "./launcher.ts";
import { setPitEscapeSocket } from "./env.ts";
import { SocketAliveError } from "./errors.ts";
import { spawnSync } from "node:child_process";

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Start pit-escape, register the socket path in env, and return the handle.
 * Returns undefined when not applicable (main worktree, etc.).
 */
const applyEscapeEffect = (
  cwd: string,
  sessionId: string,
  settingsPath: string,
): Effect.Effect<EscapeHandle | undefined, SocketAliveError, NodeContext> =>
  Effect.gen(function* () {
    const opt = yield* startPitEscapeEffect(cwd, sessionId, settingsPath);
    if (Option.isSome(opt)) setPitEscapeSocket(opt.value.socketPath);
    return Option.getOrUndefined(opt);
  });

// ── constants ─────────────────────────────────────────────────────────────

const PI_SUBCOMMANDS = new Set([
  "install", "remove", "uninstall", "update", "list", "config",
]);
const INFO_ONLY_FLAGS = new Set([
  "-h", "--help", "-v", "--version", "--list-models", "--export",
]);
const SESSION_FLAGS = new Set([
  "-c", "--continue", "--session", "--no-session", "--fork",
]);

// ── cleanup helper ────────────────────────────────────────────────────────────

export const unlinkSilent = (p: string): Effect.Effect<void, never, never> =>
  Effect.sync(() => { try { unlinkSync(p); } catch { /* already gone */ } });

// ── resume via session picker ─────────────────────────────────────────────────

export const showPicker = async (
  piArgs: string[],
  sandbox: boolean,
): Promise<{ sessionFile: string; meta: PitMetadata; sessionCwd: string; sessionUUID: string } | null> => {
  const { TUI, ProcessTerminal } = await import("@earendil-works/pi-tui");
  initTheme();

  const selectedPath = await new Promise<string | null>((resolve) => {
    const terminal = new ProcessTerminal();
    const tui = new TUI(terminal, true);

    const selector = new SessionSelectorComponent(
      async (progress) => {
        const cwd = process.cwd();
        const rawRepo = await Effect.runPromise(gitRepoRoot().pipe(Effect.provide(NodeContextLayer)));
        const isLinked = await Effect.runPromise(isLinkedWorktree(cwd).pipe(Effect.provide(NodeContextLayer)));

        // 2.3: When running from inside a worktree, only show sessions for
        // this worktree — not siblings or the parent repo.
        if (isLinked) {
          return SessionManager.list(cwd, undefined, progress).catch(() => []);
        }

        const mainRepo = isLinked
          ? await Effect.runPromise(resolveMainRepo(cwd).pipe(Effect.provide(NodeContextLayer)))
          : null;
        const repo = rawRepo && isLinked ? (mainRepo ?? rawRepo) : rawRepo;

        const worktrees = repo
          ? await Effect.runPromise(
              listRepoWorktrees(repo).pipe(
                Effect.catchAll(() => Effect.succeed([] as string[])),
                Effect.provide(NodeContextLayer),
              ),
            )
          : [];

        // Read live branch for each worktree; detect the warning case
        // (dir exists but is not a proper linked worktree) vs simply deleted.
        const { existsSync } = await import("node:fs");
        const worktreeEntries: Array<[string, string, boolean]> = await Promise.all(
          worktrees.map(async (wt) => {
            const branch = await Effect.runPromise(
              readWorktreeBranch(wt).pipe(
                Effect.map((b) => b ?? null),
                Effect.provide(NodeContextLayer),
              ),
            );
            // 3.4: warning = dir exists but isLinkedWorktree returned false
            const dirExists = existsSync(wt);
            const warn = dirExists && branch === null;
            return [wt, branch ?? "deleted", warn] as [string, string, boolean];
          }),
        );
        const worktreeBranch = new Map(worktreeEntries.map(([wt, b]) => [wt, b]));
        const worktreeWarn  = new Map(worktreeEntries.map(([wt,, w]) => [wt, w]));

        const mainPaths = new Set([
          ...(repo ? [repo] : []),
          ...(isLinked ? [] : [cwd]),
        ]);

        const [mainGroups, wtGroups] = await Promise.all([
          Promise.all(
            [...mainPaths].map((p) =>
              SessionManager.list(p, undefined, progress).catch(() => [] as Awaited<ReturnType<typeof SessionManager.list>>),
            ),
          ),
          Promise.all(
            worktrees.map((wt) =>
              SessionManager.list(wt, undefined, progress).catch(() => [] as Awaited<ReturnType<typeof SessionManager.list>>),
            ),
          ),
        ]);

        const label = (branch: string, warn: boolean) =>
          `${warn ? "⚠ " : ""}[worktree branch:${branch}]`;
        const marked = worktrees.flatMap((wt, i) =>
          wtGroups[i].map((s) => {
            const l = label(worktreeBranch.get(wt)!, worktreeWarn.get(wt) ?? false);
            return s.name
              ? { ...s, name: `${l} ${s.name}` }
              : { ...s, firstMessage: `${l} ${s.firstMessage}` };
          }),
        );

        return [...new Map([...mainGroups.flat(), ...marked].map(s => [s.path, s])).values()]
          .sort((a, b) => b.modified.getTime() - a.modified.getTime());
      },
      (progress) => SessionManager.listAll(progress),
      (sessionPath) => { tui.stop(); resolve(sessionPath); },
      () => { tui.stop(); resolve(null); },
      () => { tui.stop(); resolve(null); },
      () => tui.requestRender(),
    );

    tui.start();
    tui.addChild(selector);
    tui.setFocus(selector);
  });

  if (!selectedPath) return null;

  try {
    const sm = SessionManager.open(selectedPath);
    const pitEntry = sm.getEntries().find(
      (e): e is CustomEntry<PitMetadata> =>
        e.type === "custom" && (e as CustomEntry).customType === "pit",
    );
    const sessionCwd = sm.getCwd() ?? selectedPath;
    const sessionUUID = sm.getSessionId();
    if (!pitEntry?.data) {
      // No pit metadata — still launch in the session's own cwd, not process.cwd().
      await Effect.runPromise(
        launchEffect(sessionCwd, ["--session", selectedPath, ...piArgs], sandbox).pipe(
          Effect.provide(NodeContextLayer),
        ),
      );
      return null;
    }
    return { sessionFile: selectedPath, meta: pitEntry.data, sessionCwd, sessionUUID };
  } catch {
    console.warn("pit: could not read session metadata — opening session directly");
    await Effect.runPromise(
      launchEffect(process.cwd(), ["--session", selectedPath, ...piArgs], sandbox).pipe(
        Effect.provide(NodeContextLayer),
      ),
    );
    return null;
  }
};

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

    const result = yield* worktreeCheckEffect({ meta: picked.meta, cwd: picked.sessionCwd });
    const sandboxMounts = yield* resolveSandboxMountsEffect(result.cwd, sandbox);
    const settingsPath = yield* createTempSettingsFileEffect(AGENT_DIR, pitConfig);
    const escape = yield* applyEscapeEffect(result.cwd, picked.sessionUUID, settingsPath);

    yield* launchEffect(
      result.cwd,
      ["--session", picked.sessionFile, ...systemPromptArgs(sandboxMounts), ...piArgs],
      sandbox, settingsPath, sandboxMounts, pitConfig, escape,
    );
    yield* unlinkSilent(settingsPath);
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
    const sandboxMounts = yield* resolveSandboxMountsEffect(cwd, sandbox);
    const session = yield* findOrCreateLinkedSession(cwd, AGENT_DIR, sandboxMounts);
    if (session.kind === "new") {
    console.error("pit: already in a git worktree — no pit session found, running no-tree");
    }
    const settingsPath = yield* createTempSettingsFileEffect(AGENT_DIR, pitConfig);
    const sessionUUID2 = SessionManager.open(session.sessionFile).getSessionId();
    const escape2 = yield* applyEscapeEffect(cwd, sessionUUID2, settingsPath);

    yield* launchEffect(
      cwd,
      ["--session", session.sessionFile, ...systemPromptArgs(sandboxMounts), ...filteredArgv],
      sandbox, settingsPath, sandboxMounts, pitConfig, escape2,
    );
    yield* unlinkSilent(settingsPath);
    return;
  }

  // ── new session ───────────────────────────────────────────────────────────
  const result = yield* worktreeCheckEffect(undefined, noTree);
  const settingsPath = yield* createTempSettingsFileEffect(AGENT_DIR, pitConfig);

  if (userManagingSession) {
    // Escape server still starts for sandboxed user-managed sessions.
    const escapeUM = yield* applyEscapeEffect(result.cwd, randomUUID(), settingsPath);
    yield* launchEffect(result.cwd, filteredArgv, sandbox, settingsPath, undefined, pitConfig, escapeUM);
  } else {
    const sandboxMounts = yield* resolveSandboxMountsEffect(result.cwd, sandbox);
    const sessionFile = yield* setupNewSession(result, AGENT_DIR, sandboxMounts);
    const sessionUUID3 = SessionManager.open(sessionFile).getSessionId();
    const escape3 = yield* applyEscapeEffect(result.cwd, sessionUUID3, settingsPath);
    yield* launchEffect(result.cwd, [
      "--session", sessionFile,
      ...systemPromptArgs(sandboxMounts),
      ...filteredArgv,
    ], sandbox, settingsPath, sandboxMounts, pitConfig, escape3);
  }
  yield* unlinkSilent(settingsPath);
});
