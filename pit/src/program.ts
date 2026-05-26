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
import type { PitMetadata, SandboxMounts } from "./types.ts";
import { AGENT_DIR, PIT_DIR } from "./core/constants.ts";
import { parseFlags } from "./core/worktree/pure.ts";
import { worktreeCheckEffect } from "./core/worktree/io.ts";
import { systemPromptArgs } from "./core/session/pure.ts";
import { setupNewSession, findOrCreateLinkedSession } from "./core/session/io.ts";
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
import { spawnSync } from "node:child_process";

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

// ── cleanup helper ────────────────────────────────────────────────────────────

export const unlinkSilent = (p: string): Effect.Effect<void, never, never> =>
  Effect.sync(() => { try { unlinkSync(p); } catch { /* already gone */ } });

// ── resume via session picker ─────────────────────────────────────────────────

export const showPicker = async (
  piArgs: string[],
  sandbox: boolean,
): Promise<{ sessionFile: string; meta: PitMetadata } | null> => {
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

        const worktreeBranchEntries: Array<[string, string]> = await Promise.all(
          worktrees.map(async (wt) => {
            const branch = await Effect.runPromise(
              readWorktreeBranch(wt).pipe(
                Effect.map((b) => b ?? "deleted"),
                Effect.provide(NodeContextLayer),
              ),
            );
            return [wt, branch] as [string, string];
          }),
        );
        const worktreeBranch = new Map(worktreeBranchEntries);

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

        const label = (branch: string) => `[worktree branch:${branch}]`;
        const marked = worktrees.flatMap((wt, i) =>
          wtGroups[i].map((s) => {
            const l = label(worktreeBranch.get(wt)!);
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
    if (!pitEntry?.data) {
      await Effect.runPromise(
        launchEffect(process.cwd(), ["--session", selectedPath, ...piArgs], sandbox).pipe(
          Effect.provide(NodeContextLayer),
        ),
      );
      return null;
    }
    return { sessionFile: selectedPath, meta: pitEntry.data };
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

    const result = yield* worktreeCheckEffect(picked.meta);
    const sandboxMounts = yield* resolveSandboxMountsEffect(result.cwd, sandbox);
    const settingsPath = yield* createTempSettingsFileEffect(AGENT_DIR, pitConfig);
    const escapeOpt = yield* startPitEscapeEffect(result.cwd, result.meta.id, settingsPath);
    if (Option.isSome(escapeOpt)) setPitEscapeSocket(escapeOpt.value.socketPath);
    const escapeToken = Option.isSome(escapeOpt) ? escapeOpt.value.token : undefined;

    yield* launchEffect(
      result.cwd,
      ["--session", picked.sessionFile, ...systemPromptArgs(result.meta, sandboxMounts), ...piArgs],
      sandbox, settingsPath, sandboxMounts, pitConfig, escapeToken,
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
    const escapeOpt2 = yield* startPitEscapeEffect(cwd, session.meta.id, settingsPath);
    if (Option.isSome(escapeOpt2)) setPitEscapeSocket(escapeOpt2.value.socketPath);
    const escapeToken2 = Option.isSome(escapeOpt2) ? escapeOpt2.value.token : undefined;

    yield* launchEffect(
      cwd,
      ["--session", session.sessionFile, ...systemPromptArgs(session.meta, sandboxMounts), ...filteredArgv],
      sandbox, settingsPath, sandboxMounts, pitConfig, escapeToken2,
    );
    yield* unlinkSilent(settingsPath);
    return;
  }

  // ── new session ───────────────────────────────────────────────────────────
  const result = yield* worktreeCheckEffect(undefined, noTree);
  const settingsPath = yield* createTempSettingsFileEffect(AGENT_DIR, pitConfig);
  const escapeOpt3 = yield* startPitEscapeEffect(result.cwd, result.meta.id, settingsPath);
  if (Option.isSome(escapeOpt3)) setPitEscapeSocket(escapeOpt3.value.socketPath);
  const escapeToken3 = Option.isSome(escapeOpt3) ? escapeOpt3.value.token : undefined;

  if (userManagingSession) {
    yield* launchEffect(result.cwd, filteredArgv, sandbox, settingsPath, undefined, pitConfig, escapeToken3);
  } else {
    const sandboxMounts = yield* resolveSandboxMountsEffect(result.cwd, sandbox);
    const sessionFile = yield* setupNewSession(result, AGENT_DIR, sandboxMounts);
    yield* launchEffect(result.cwd, [
      "--session", sessionFile,
      ...systemPromptArgs(result.meta, sandboxMounts),
      ...filteredArgv,
    ], sandbox, settingsPath, sandboxMounts, pitConfig, escapeToken3);
  }
  yield* unlinkSilent(settingsPath);
});
