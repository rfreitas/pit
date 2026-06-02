/**
 * Main program Effect for pit — worktree routing and session management.
 */

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { layer as NodeContextLayer, type NodeContext } from "./node-context.ts";
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
import { worktreeCheckEffect, createFreshWorktreeEffect, type ExistingSession } from "./core/worktree/io.ts";
import { systemPromptArgs } from "./core/session/pure.ts";
import { setupNewSession, findOrCreateLinkedSession, refreshPitBranchIfStale, scanSessionsByRepo } from "./core/session/io.ts";
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

// ── picker discovery (extracted for testability) ──────────────────────────

/** 
 * Represents a session loaded for the picker. Ensures we fulfill the
 * UI component's render contract at compile time.
 */
export interface PickerSession {
  path: string;
  modified: Date;
  firstMessage?: string;
  name?: string;
  cwd?: string | null;
  messageCount?: number;
  branch?: string; // checked-out branch name
  [key: string]: unknown; // Allow passthrough of other SessionManager fields
}

/**
 * Production-line helper to check if a branch exists locally in Git.
 * Exported so that our TUI E2E tests can execute the real plumbing under test.
 */
export const productionBranchExists = (
  branch: string,
  repo: string | null,
): Promise<boolean> =>
  Effect.runPromise(
    Effect.promise(async () => {
      try {
        const { execSync } = await import("node:child_process");
        execSync(`git show-ref --verify refs/heads/${branch}`, { cwd: repo ?? undefined, stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    })
  );

/**
 * Discover sessions for the picker by combining live git worktree data
 * with a metadata scan for pruned worktrees.
 *
 * When isLinked=true, returns ONLY sessions for the current cwd (worktree
 * isolation — Fix 2.3).
 *
 * Otherwise:
 *   1. Query sessions for each known worktree path (from git worktree list).
 *   2. Scan all session files for any whose meta.repo matches the current repo
 *      but whose cwd is NOT in the git worktree list (pruned worktrees).
 *   3. Deduplicate by session path.
 *   4. Label worktree sessions with live branch name; add ⚠ when the dir
 *      exists but readWorktreeBranch returns null (Fix 2.4).
 */
export const discoverSessionsForPicker = async (
  opts: Readonly<{
    cwd: string;
    repo: string | null;
    isLinked: boolean;
    worktrees: readonly string[];
    agentDir: string;
  }>,
  deps: Readonly<{
    listSessions: (cwd: string) => Promise<readonly PickerSession[]>;
    readWorktreeBranch: (wt: string) => Promise<string | null>;
    existsSync: (p: string) => boolean;
    branchExists: (branch: string) => Promise<boolean>;
    scanSessionsByRepo: (repo: string, agentDir: string) => Promise<readonly PickerSession[]>;
  }>,
): Promise<readonly PickerSession[]> => {
  // 2.3: Worktree isolation — when inside a linked worktree, only show
  // sessions for THIS worktree, not siblings or the parent repo.
  if (opts.isLinked) {
    return deps.listSessions(opts.cwd).catch(() => []);
  }

  const mainPaths = opts.repo ? [opts.repo, opts.cwd] : [opts.cwd];

  // 1. Sessions from git-known worktree paths
  const worktreeBranchInfo: Array<[string, string | null]> = await Promise.all(
    opts.worktrees.map(async (wt) => {
      const branch = await deps.readWorktreeBranch(wt);
      return [wt, branch] as [string, string | null];
    }),
  );
  const worktreeBranch = new Map(worktreeBranchInfo.map(([wt, b]) => [wt, b]));

  const [mainGroups, wtGroups] = await Promise.all([
    Promise.all(
      mainPaths.map((p) => deps.listSessions(p).catch(() => [] as PickerSession[])),
    ),
    Promise.all(
      opts.worktrees.map((wt) => deps.listSessions(wt).catch(() => [] as PickerSession[])),
    ),
  ]);

  // Label worktree sessions dynamically based on disk and branch state
  const markedPromises = opts.worktrees.flatMap((wt, i) =>
    wtGroups[i].map(async (s) => {
      const branch = worktreeBranch.get(wt);
      const dirExists = deps.existsSync(wt);
      const hasBranch = branch ? await deps.branchExists(branch) : false;

      let labelText = "";
      if (dirExists) {
        if (branch && branch !== "deleted" && hasBranch) {
          labelText = `[worktree branch:${branch}]`;
        } else if (branch && branch !== "deleted" && !hasBranch) {
          labelText = `⚠ [deleted branch:${branch}]`;
        } else {
          labelText = `⚠ [deleted branch]`;
        }
      } else {
        if (branch && branch !== "deleted" && hasBranch) {
          labelText = `[missing worktree branch:${branch}]`;
        } else {
          labelText = `[deleted branch:${branch ?? "unknown"}]`;
        }
      }

      return s.name
        ? { ...s, name: `${labelText} ${s.name}` }
        : { ...s, firstMessage: `${labelText} ${s.firstMessage ?? "(no messages)"}` };
    }),
  );

  const flatMarked = await Promise.all(markedPromises).then((g) => g.flat());

  // 2.1: Metadata scan for pruned worktrees — only include sessions whose
  // paths are NOT already known from SessionManager.list() (git worktree list
  // or main repo).
  const knownPaths = new Set([
    ...mainGroups.flat().map((s) => s.path),
    ...flatMarked.map((s) => s.path),
  ]);

  const prunedSessions = opts.repo
    ? (await deps.scanSessionsByRepo(opts.repo, opts.agentDir).catch(() => [] as PickerSession[]))
        .filter((s) => !knownPaths.has(s.path))
    : [];

  const markedPruned = await Promise.all(
    prunedSessions.map(async (s) => {
      const b = s.branch ?? "unknown";
      const dirExists = s.cwd ? deps.existsSync(s.cwd) : false;
      const hasBranch = await deps.branchExists(b);

      let labelText = "";
      if (dirExists) {
        if (hasBranch) {
          labelText = `⚠ [unregistered worktree:${b}]`;
        } else {
          labelText = `⚠ [deleted branch:${b}]`;
        }
      } else {
        if (hasBranch) {
          labelText = `[missing worktree branch:${b}]`;
        } else {
          labelText = `[deleted branch:${b}]`;
        }
      }

      return s.name
        ? { ...s, name: `${labelText} ${s.name}` }
        : { ...s, firstMessage: `${labelText} ${s.firstMessage ?? "(no messages)"}` };
    })
  );

  // Combine without dedup needed — prunedSessions are already filtered to novel paths
  const combined = [...mainGroups.flat(), ...flatMarked, ...markedPruned];

  return [...combined]
    .sort((a, b) => b.modified.getTime() - a.modified.getTime());
};

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

// ── tui prompts ───────────────────────────────────────────────────────────────

export const showBranchDeletedPrompt = async (
  branch: string,
): Promise<boolean> => {
  const { TUI, ProcessTerminal } = await import("@earendil-works/pi-tui");
  const { ExtensionSelectorComponent, initTheme } = await import("@earendil-works/pi-coding-agent");
  initTheme();

  return new Promise<boolean>((resolve) => {
    const terminal = new ProcessTerminal();
    const tui = new TUI(terminal, true);

    const title = `Branch ${branch} no longer exists. Create a fresh branch off main?`;
    const options = ["Yes", "No"];

    const selector = new ExtensionSelectorComponent(
      title,
      options,
      (selected) => {
        tui.stop();
        resolve(selected === "Yes");
      },
      () => {
        tui.stop();
        resolve(false);
      }
    );

    tui.start();
    tui.addChild(selector);
    tui.setFocus(selector);
  });
};

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

        const { existsSync } = await import("node:fs");
        const sessions = await discoverSessionsForPicker(
          { cwd, repo, isLinked, worktrees, agentDir: AGENT_DIR },
          {
            listSessions: (p) => SessionManager.list(p, undefined, progress).catch(() => []) as unknown as Promise<PickerSession[]>,
            readWorktreeBranch: (wt) =>
              Effect.runPromise(readWorktreeBranch(wt).pipe(Effect.provide(NodeContextLayer))),
            existsSync,
            branchExists: (branch) => productionBranchExists(branch, repo),
            scanSessionsByRepo,
          },
        );
        return sessions as unknown as Awaited<ReturnType<typeof SessionManager.list>>;
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
    const sandboxMounts = yield* resolveSandboxMountsEffect(cwd, sandbox, pitConfig);
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
    const sandboxMounts = yield* resolveSandboxMountsEffect(result.cwd, sandbox, pitConfig);
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
