#!/usr/bin/env -S node --experimental-strip-types
/**
 * pit — pi tree
 *
 * A transparent wrapper around pi that manages git worktrees.
 * Every pi flag works identically. pit adds --no-sandbox and intercepts -r.
 *
 * Usage:
 *   pit [pi-flags...] [messages...]   Create a worktree (if in git repo) and launch pi
 *   pit --no-sandbox [...]            Same, without bwrap sandboxing
 *   pit -nt / --no-tree [...]         Skip worktree creation; run in current dir
 *   pit -r [id] [pi-flags...]         Pick or directly open an existing pit session
 *   pit install/remove/update/...     Forwarded directly to pi
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execSync, spawnSync, spawn } from "node:child_process";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { layer as NodeContextLayer, type NodeContext } from "@effect/platform-node/NodeContext";
import {
  main,
  SessionManager,
  SessionSelectorComponent,
  initTheme,
  getAgentDir,
  type CustomEntry,
} from "@earendil-works/pi-coding-agent";
import type { PitMetadata, SandboxMounts, OverlayMount } from "./types.ts";
import { parseFlags } from "./worktree/pure.ts";
import { worktreeCheckEffect } from "./worktree/io.ts";
import { systemPromptArgs } from "./session/pure.ts";
import {
  setupNewSession,
  findOrCreateLinkedSession,
} from "./session/io.ts";
import { buildSandboxMountSpec } from "./sandbox/pure.ts";
import {
  resolveUnversionedDirs,
  readPitConfig,
  createTempSettingsFileEffect,
} from "./sandbox/io.ts";
import { probeSocketEffect } from "./escape/client.ts";
import {
  isLinkedWorktree,
  resolveMainRepo,
  listRepoWorktrees,
  readWorktreeBranch,
  resolveWorktreeGitRwMounts,
  gitRepoRoot,
} from "./git/utils.ts";
import {
  WorktreeCreationError,
  WorktreeMissingError,
  SocketAliveError,
  SessionWriteError,
  SettingsWriteError,
} from "./errors.ts";

// ── constants ─────────────────────────────────────────────────────────────────

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? "/";
const AGENT_DIR = getAgentDir();

const PI_SUBCOMMANDS = new Set([
  "install", "remove", "uninstall", "update", "list", "config",
]);
const INFO_ONLY_FLAGS = new Set([
  "-h", "--help", "-v", "--version", "--list-models", "--export",
]);
const SESSION_FLAGS = new Set([
  "-c", "--continue", "--session", "--no-session", "--fork",
]);

// ── pit dir ───────────────────────────────────────────────────────────────────

const PIT_DIR = join(AGENT_DIR, "pit");

// ── extension args ────────────────────────────────────────────────────────────

function extensionArgs(): string[] {
  const d = resolve(dirname(process.argv[1]));
  return [
    join(d, "escape", "reload.ts"),
    join(d, "tools", "git.ts"),
    join(d, "commands", "merge.ts"),
    join(d, "commands", "merge-status.ts"),
    join(d, "commands", "rename-branch.ts"),
  ].flatMap((f) => ["--extension", f]);
}

// ── sandbox ───────────────────────────────────────────────────────────────────

function findBwrap(): string | null {
  for (const p of ["/usr/bin/bwrap", "/usr/local/bin/bwrap"]) {
    if (existsSync(p)) return p;
  }
  return null;
}

function getExtensionMounts(): string[] {
  const settingsFile = join(AGENT_DIR, "settings.json");
  if (!existsSync(settingsFile)) return [];
  let settings: { extensions?: string[] };
  try {
    const raw = readFileSync(settingsFile, "utf8");
    if (!raw.trim()) return [];
    settings = JSON.parse(raw) as { extensions?: string[] };
  } catch {
    return [];
  }
  const mounts = new Set<string>();
  for (const ext of settings.extensions ?? []) {
    if (!existsSync(ext)) continue;
    mounts.add(ext);
    let parent = dirname(ext);
    while (true) {
      const nm = join(parent, "node_modules");
      if (existsSync(nm)) { mounts.add(nm); break; }
      const up = dirname(parent);
      if (up === parent) break;
      parent = up;
    }
  }
  return [...mounts].sort();
}

/**
 * Build sandbox mounts.
 * resolveUnversionedDirs failure → warns + skips overlays (graceful degradation).
 * resolveWorktreeGitRwMounts failure → empty mounts (caller sees typed error).
 */
const buildSandboxMountsEffect = (
  cwd: string,
  agentDirReal: string,
  extensionMounts: string[],
  nodeDir: string,
): Effect.Effect<SandboxMounts, never, NodeContext> =>
  Effect.gen(function* () {
    const parentRepo = yield* resolveMainRepo(cwd);
    const overlayDirs: OverlayMount[] = [];
    if (parentRepo) {
      const unversioned = yield* resolveUnversionedDirs(parentRepo).pipe(
        Effect.catchAll((e) =>
          Effect.sync(() => {
            console.warn(`pit: overlay mounts unavailable: ${String(e)}`);
            return [] as string[];
          }),
        ),
      );
      for (const rel of unversioned) {
        const src = join(parentRepo, rel);
        const dest = join(cwd, rel);
        try {
          if (statSync(src).isDirectory()) overlayDirs.push({ src, dest, label: rel });
        } catch { /* src disappeared */ }
      }
    }
    const gitRwMounts = yield* resolveWorktreeGitRwMounts(cwd);
    return buildSandboxMountSpec({
      home: HOME, cwd, agentDirReal, extensionMounts, nodeDir, gitRwMounts, overlayDirs,
    });
  });

const resolveSandboxMountsEffect = (
  cwd: string,
  useSandbox: boolean,
): Effect.Effect<SandboxMounts | undefined, never, NodeContext> =>
  Effect.gen(function* () {
    if (!useSandbox || !findBwrap()) return undefined;
    const nodeDir = dirname(dirname(process.execPath));
    return yield* buildSandboxMountsEffect(
      cwd, realpathSync(AGENT_DIR), getExtensionMounts(), nodeDir,
    );
  });

// ── launch ────────────────────────────────────────────────────────────────────

function shadowAgentMountArgs(agentDirReal: string, settingsPath: string): string[] {
  return [
    "--bind", agentDirReal, "/pit-agent",
    "--bind", settingsPath, "/pit-agent/settings.json",
  ];
}

/**
 * Spawn the sandboxed pi session via bwrap.
 * Mounts are pre-computed by the Effect pipeline and passed in.
 * Never returns — exits the process.
 */
function bwrapLaunch(
  cwd: string,
  piArgs: string[],
  mounts: SandboxMounts,
  settingsPath?: string,
): never {
  const bwrap = findBwrap()!;
  const nodeBin = process.execPath;
  const nodeDir = dirname(dirname(nodeBin));
  const piScript = realpathSync(execSync("which pi", { encoding: "utf8" }).trim());

  const mountArgs: string[] = [];
  for (const m of mounts.ro) {
    mountArgs.push(m.optional ? "--ro-bind-try" : "--ro-bind", m.path, m.path);
  }
  for (const m of mounts.rw) {
    mountArgs.push("--bind", m.path, m.path);
  }
  for (const m of mounts.overlay ?? []) {
    mkdirSync(m.dest, { recursive: true });
    mountArgs.push("--overlay-src", m.src, "--tmp-overlay", m.dest);
  }

  const agentDirReal = realpathSync(AGENT_DIR);
  const shadowArgs = settingsPath ? shadowAgentMountArgs(agentDirReal, settingsPath) : [];
  const agentDirEnv = settingsPath ? ["--setenv", "PI_CODING_AGENT_DIR", "/pit-agent"] : [];

  const args: string[] = [
    "--tmpfs", "/", "--dev", "/dev", "--proc", "/proc",
    ...mountArgs, ...shadowArgs,
    "--unshare-user", "--unshare-pid", "--die-with-parent",
    "--setenv", "HOME", HOME,
    "--setenv", "PATH", `${nodeDir}/bin:/usr/local/bin:/usr/bin:/bin`,
    "--setenv", "PI_CODING_AGENT", "true",
    ...agentDirEnv,
    "--chdir", cwd,
    "--", nodeBin, piScript, ...piArgs,
  ];

  const result = spawnSync(bwrap, args, { stdio: "inherit" });
  if (settingsPath) try { unlinkSync(settingsPath); } catch { /* already gone */ }
  process.exit(result.status ?? 1);
}

const launchEffect = (
  cwd: string,
  piArgs: string[],
  sandbox: boolean,
  settingsPath?: string,
  mounts?: SandboxMounts,
): Effect.Effect<void, never, NodeContext> =>
  Effect.gen(function* () {
    if (sandbox) {
      const bwrap = findBwrap();
      if (bwrap) {
        const m = mounts ?? (yield* buildSandboxMountsEffect(
          cwd,
          realpathSync(AGENT_DIR),
          getExtensionMounts(),
          dirname(dirname(process.execPath)),
        ));
        bwrapLaunch(cwd, piArgs, m, settingsPath); // never returns
      }
      console.warn("pit: bwrap not found — running without sandbox");
    }
    process.chdir(cwd);
    yield* Effect.promise(() => main(piArgs).catch(() => {}));
  });

// ── pit-escape ────────────────────────────────────────────────────────────────

const startPitEscapeEffect = (
  worktreeCwd: string,
  sessionId: string,
  settingsPath: string,
): Effect.Effect<Option.Option<string>, SocketAliveError, NodeContext> =>
  Effect.gen(function* () {
    const isMain = yield* isLinkedWorktree(worktreeCwd).pipe(
      Effect.map((linked) => !linked),
    );
    if (isMain) return Option.none();

    const socketPath = join(AGENT_DIR, `pit-${sessionId}.sock`);
    const probe = yield* probeSocketEffect(socketPath);
    if (probe === "alive") return yield* Effect.fail(new SocketAliveError({ sessionId }));

    yield* Effect.sync(() => { try { unlinkSync(socketPath); } catch { /* gone */ } });

    const scriptDir = resolve(dirname(process.argv[1]));
    const escapeScript = join(scriptDir, "escape", "server.ts");

    return yield* Effect.async<Option.Option<string>>((resume) => {
      const child = spawn(
        process.execPath,
        [
          "--experimental-strip-types", escapeScript,
          socketPath, worktreeCwd, realpathSync(AGENT_DIR), PIT_DIR, settingsPath,
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );

      process.on("exit", () => {
        try { child.kill("SIGTERM"); } catch { /* gone */ }
        try { unlinkSync(socketPath); } catch { /* gone */ }
      });

      const timer = setTimeout(() => {
        console.warn("pit: pit-escape timed out — git tool and settings refresh unavailable");
        resume(Effect.succeed(Option.none()));
      }, 3000);

      child.stdout!.once("data", () => { clearTimeout(timer); resume(Effect.succeed(Option.some(socketPath))); });
      child.once("error", (err) => { clearTimeout(timer); console.warn(`pit: pit-escape: ${err.message}`); resume(Effect.succeed(Option.none())); });
      child.once("exit", (code) => { if (code !== 0) { clearTimeout(timer); resume(Effect.succeed(Option.none())); } });
    });
  });

// ── resume via session picker ─────────────────────────────────────────────────

async function showPicker(
  piArgs: string[],
  sandbox: boolean,
): Promise<{ sessionFile: string; meta: PitMetadata } | null> {
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

        const mainPaths = new Set<string>();
        if (repo) mainPaths.add(repo);
        if (!isLinked) mainPaths.add(cwd);

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

        const seen = new Set<string>();
        return [...mainGroups.flat(), ...marked]
          .filter((s) => { if (seen.has(s.path)) return false; seen.add(s.path); return true; })
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
    return null;
  }
}

// ── cleanup helper ────────────────────────────────────────────────────────────

const unlinkSilent = (p: string): Effect.Effect<void, never, never> =>
  Effect.sync(() => { try { unlinkSync(p); } catch { /* already gone */ } });

// ── dispatch ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

const program = Effect.gen(function* () {
  const { sandbox, noTree, filteredArgv } = parseFlags(argv);

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
    const settingsPath = yield* createTempSettingsFileEffect(AGENT_DIR, yield* readPitConfig(PIT_DIR));
    const socketOpt = yield* startPitEscapeEffect(result.cwd, result.meta.id, settingsPath);
    if (Option.isSome(socketOpt)) process.env.PIT_ESCAPE_SOCKET = socketOpt.value;

    yield* launchEffect(
      result.cwd,
      ["--session", picked.sessionFile, ...extensionArgs(), ...systemPromptArgs(result.meta, sandboxMounts), ...piArgs],
      sandbox, settingsPath, sandboxMounts,
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
    const settingsPath = yield* createTempSettingsFileEffect(AGENT_DIR, yield* readPitConfig(PIT_DIR));
    const socketOpt = yield* startPitEscapeEffect(cwd, session.meta.id, settingsPath);
    if (Option.isSome(socketOpt)) process.env.PIT_ESCAPE_SOCKET = socketOpt.value;

    yield* launchEffect(
      cwd,
      ["--session", session.sessionFile, ...extensionArgs(), ...systemPromptArgs(session.meta, sandboxMounts), ...filteredArgv],
      sandbox, settingsPath, sandboxMounts,
    );
    yield* unlinkSilent(settingsPath);
    return;
  }

  // ── new session ───────────────────────────────────────────────────────────
  const result = yield* worktreeCheckEffect(undefined, noTree);
  const settingsPath = yield* createTempSettingsFileEffect(AGENT_DIR, yield* readPitConfig(PIT_DIR));
  const socketOpt = yield* startPitEscapeEffect(result.cwd, result.meta.id, settingsPath);
  if (Option.isSome(socketOpt)) process.env.PIT_ESCAPE_SOCKET = socketOpt.value;

  let piArgs: string[];
  if (userManagingSession) {
    piArgs = filteredArgv;
  } else {
    const sandboxMounts = yield* resolveSandboxMountsEffect(result.cwd, sandbox);
    const sessionFile = yield* setupNewSession(result, AGENT_DIR, sandboxMounts);
    piArgs = [
      "--session", sessionFile,
      ...extensionArgs(),
      ...systemPromptArgs(result.meta, sandboxMounts),
      ...filteredArgv,
    ];
    yield* launchEffect(result.cwd, piArgs, sandbox, settingsPath, sandboxMounts);
    yield* unlinkSilent(settingsPath);
    return;
  }

  yield* launchEffect(result.cwd, piArgs, sandbox, settingsPath);
  yield* unlinkSilent(settingsPath);
});

// ── edge: run the program ─────────────────────────────────────────────────────

type PitError =
  | WorktreeCreationError
  | WorktreeMissingError
  | SocketAliveError
  | SessionWriteError
  | SettingsWriteError;

Effect.runPromise(
  program.pipe(
    Effect.catchTag("WorktreeMissingError", (e) =>
      Effect.sync(() => {
        console.error(`pit: branch '${e.branch}' no longer exists — cannot recreate worktree`);
        process.exit(1);
      }),
    ),
    Effect.catchTag("SocketAliveError", (e) =>
      Effect.sync(() => {
        console.error(
          `pit: session ${e.sessionId} is already open in another terminal.\n` +
          `     Exit that session first, or resume a different one.`,
        );
        process.exit(1);
      }),
    ),
    Effect.catchAll((e: PitError) =>
      Effect.sync(() => {
        console.error(`pit: ${e.message}`);
        process.exit(1);
      }),
    ),
    Effect.provide(NodeContextLayer),
  ),
).catch((err: unknown) => {
  console.error(`pit: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
