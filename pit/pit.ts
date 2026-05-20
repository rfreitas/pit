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

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync, spawnSync, spawn } from "node:child_process";
import { Effect, Option } from "effect";
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
import { systemPromptArgs, buildAnnouncement } from "./session/pure.ts";
import { setupNewSession, findOrCreateLinkedSessionEffect } from "./session/io.ts";
import { buildSandboxMountSpec, applyDenylist } from "./sandbox/pure.ts";
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

/** Subcommands that have nothing to do with sessions — forward to pi directly */
const PI_SUBCOMMANDS = new Set([
  "install",
  "remove",
  "uninstall",
  "update",
  "list",
  "config",
]);

/** Flags where pit should skip worktree creation and just pass through to pi */
const INFO_ONLY_FLAGS = new Set([
  "-h",
  "--help",
  "-v",
  "--version",
  "--list-models",
  "--export",
]);

/** Flags indicating the user is explicitly managing their own session */
const SESSION_FLAGS = new Set([
  "-c",
  "--continue",
  "--session",
  "--no-session",
  "--fork",
]);

// ── pit dir ───────────────────────────────────────────────────────────────────

/** ~/.pi/agent/pit — inside the repo-tracked agent config dir */
const PIT_DIR = path.join(AGENT_DIR, "pit");

// ── extension args ────────────────────────────────────────────────────────────

function extensionArgs(): string[] {
  const d = path.resolve(path.dirname(process.argv[1]));
  return [
    path.join(d, "escape", "reload.ts"),
    path.join(d, "tools", "git.ts"),
    path.join(d, "commands", "merge.ts"),
    path.join(d, "commands", "merge-status.ts"),
    path.join(d, "commands", "rename-branch.ts"),
  ].flatMap((f) => ["--extension", f]);
}

// ── sandbox ───────────────────────────────────────────────────────────────────

function findBwrap(): string | null {
  for (const p of ["/usr/bin/bwrap", "/usr/local/bin/bwrap"]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function getExtensionMounts(): string[] {
  const settingsFile = path.join(AGENT_DIR, "settings.json");
  if (!fs.existsSync(settingsFile)) return [];
  let settings: { extensions?: string[] };
  try {
    const raw = fs.readFileSync(settingsFile, "utf8");
    if (!raw.trim()) return [];
    settings = JSON.parse(raw) as { extensions?: string[] };
  } catch {
    return [];
  }
  const mounts = new Set<string>();
  for (const ext of settings.extensions ?? []) {
    if (!fs.existsSync(ext)) continue;
    mounts.add(ext);
    let parent = path.dirname(ext);
    while (true) {
      const nm = path.join(parent, "node_modules");
      if (fs.existsSync(nm)) {
        mounts.add(nm);
        break;
      }
      const up = path.dirname(parent);
      if (up === parent) break;
      parent = up;
    }
  }
  return [...mounts].sort();
}

function buildSandboxMounts(
  cwd: string,
  agentDirReal: string,
  extensionMounts: string[],
  nodeDir: string,
): SandboxMounts {
  const overlayDirs: OverlayMount[] = [];
  const parentRepo = resolveMainRepo(cwd);
  if (parentRepo) {
    for (const rel of resolveUnversionedDirs(parentRepo)) {
      const src = path.join(parentRepo, rel);
      const dest = path.join(cwd, rel);
      try {
        if (fs.statSync(src).isDirectory())
          overlayDirs.push({ src, dest, label: rel });
      } catch {
        /* src disappeared — skip */
      }
    }
  }
  return buildSandboxMountSpec({
    home: HOME,
    cwd,
    agentDirReal,
    extensionMounts,
    nodeDir,
    gitRwMounts: resolveWorktreeGitRwMounts(cwd),
    overlayDirs,
  });
}

function resolveSandboxMounts(
  cwd: string,
  useSandbox: boolean,
): SandboxMounts | undefined {
  if (!useSandbox) return undefined;
  if (!findBwrap()) return undefined;
  const nodeDir = path.dirname(path.dirname(process.execPath));
  return buildSandboxMounts(
    cwd,
    fs.realpathSync(AGENT_DIR),
    getExtensionMounts(),
    nodeDir,
  );
}

function shadowAgentMountArgs(
  agentDirReal: string,
  settingsPath: string,
): string[] {
  return [
    "--bind",
    agentDirReal,
    "/pit-agent",
    "--bind",
    settingsPath,
    "/pit-agent/settings.json",
  ];
}

// ── launch ────────────────────────────────────────────────────────────────────

/**
 * Spawn the sandboxed pi session via bwrap. Never returns — exits the process.
 */
function bwrapLaunch(
  cwd: string,
  piArgs: string[],
  settingsPath?: string,
): never {
  const bwrap = findBwrap()!;
  const nodeBin = process.execPath;
  const nodeDir = path.dirname(path.dirname(nodeBin));
  const piScript = fs.realpathSync(
    execSync("which pi", { encoding: "utf8" }).trim(),
  );

  const agentDirReal = fs.realpathSync(AGENT_DIR);
  const mounts = buildSandboxMounts(
    cwd,
    agentDirReal,
    getExtensionMounts(),
    nodeDir,
  );
  const mountArgs: string[] = [];
  for (const m of mounts.ro) {
    mountArgs.push(
      m.optional ? "--ro-bind-try" : "--ro-bind",
      m.path,
      m.path,
    );
  }
  for (const m of mounts.rw) {
    mountArgs.push("--bind", m.path, m.path);
  }
  for (const m of mounts.overlay ?? []) {
    fs.mkdirSync(m.dest, { recursive: true });
    mountArgs.push("--overlay-src", m.src, "--tmp-overlay", m.dest);
  }

  const shadowArgs = settingsPath
    ? shadowAgentMountArgs(agentDirReal, settingsPath)
    : [];
  const agentDirEnv = settingsPath
    ? ["--setenv", "PI_CODING_AGENT_DIR", "/pit-agent"]
    : [];

  const args: string[] = [
    "--tmpfs",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    ...mountArgs,
    ...shadowArgs,
    "--unshare-user",
    "--unshare-pid",
    "--die-with-parent",
    "--setenv",
    "HOME",
    HOME,
    "--setenv",
    "PATH",
    `${nodeDir}/bin:/usr/local/bin:/usr/bin:/bin`,
    "--setenv",
    "PI_CODING_AGENT",
    "true",
    ...agentDirEnv,
    "--chdir",
    cwd,
    "--",
    nodeBin,
    piScript,
    ...piArgs,
  ];

  const result = spawnSync(bwrap, args, { stdio: "inherit" });
  if (settingsPath)
    try {
      fs.unlinkSync(settingsPath);
    } catch {
      /* already gone */
    }
  process.exit(result.status ?? 1);
}

const launchEffect = (
  cwd: string,
  piArgs: string[],
  sandbox: boolean,
  settingsPath?: string,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    if (sandbox) {
      const bwrap = findBwrap();
      if (bwrap) {
        bwrapLaunch(cwd, piArgs, settingsPath); // never returns
      }
      console.warn("pit: bwrap not found — running without sandbox");
    }
    process.chdir(cwd);
    // main() handles its own errors; absorb any rejection so it doesn't
    // surface as an unhandled error in the Effect pipeline.
    yield* Effect.promise(() => main(piArgs).catch(() => {}));
  });

// ── pit-escape ────────────────────────────────────────────────────────────────

const startPitEscapeEffect = (
  worktreeCwd: string,
  sessionId: string,
  settingsPath: string,
): Effect.Effect<Option.Option<string>, SocketAliveError> =>
  Effect.gen(function* () {
    // Only start pit-escape for linked worktrees (.git is a file, not a dir)
    const gitFile = path.join(worktreeCwd, ".git");
    const isMainWorktree = yield* Effect.sync((): boolean => {
      try { return fs.statSync(gitFile).isDirectory(); }
      catch { return true; } // not a git repo — skip
    });
    if (isMainWorktree) return Option.none();

    const socketPath = path.join(AGENT_DIR, `pit-${sessionId}.sock`);

    const probe = yield* probeSocketEffect(socketPath);
    if (probe === "alive") {
      return yield* Effect.fail(new SocketAliveError({ sessionId }));
    }

    // Remove stale socket if present
    yield* Effect.sync(() => { try { fs.unlinkSync(socketPath); } catch { /* already gone */ } });

    const scriptDir = path.resolve(path.dirname(process.argv[1]));
    const escapeScript = path.join(scriptDir, "escape", "server.ts");

    const result = yield* Effect.async<Option.Option<string>>((resume) => {
      const child = spawn(
        process.execPath,
        [
          "--experimental-strip-types",
          escapeScript,
          socketPath,
          worktreeCwd,
          fs.realpathSync(AGENT_DIR),
          PIT_DIR,
          settingsPath,
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );

      process.on("exit", () => {
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
        try { fs.unlinkSync(socketPath); } catch { /* already gone */ }
      });

      const timer = setTimeout(() => {
        console.warn(
          "pit: pit-escape timed out — git tool and settings refresh unavailable",
        );
        resume(Effect.succeed(Option.none()));
      }, 3000);

      child.stdout!.once("data", () => {
        clearTimeout(timer);
        resume(Effect.succeed(Option.some(socketPath)));
      });
      child.once("error", (err) => {
        clearTimeout(timer);
        console.warn(`pit: pit-escape: ${err.message}`);
        resume(Effect.succeed(Option.none()));
      });
      child.once("exit", (code) => {
        if (code !== 0) {
          clearTimeout(timer);
          resume(Effect.succeed(Option.none()));
        }
      });
    });

    return result;
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
        const rawRepo = gitRepoRoot();
        const repo =
          rawRepo && isLinkedWorktree(cwd)
            ? (resolveMainRepo(cwd) ?? rawRepo)
            : rawRepo;
        const worktrees = repo ? listRepoWorktrees(repo) : [];

        const worktreeBranch = new Map(
          worktrees.map((wt) => [wt, readWorktreeBranch(wt) ?? "deleted"]),
        );

        const mainPaths = new Set<string>();
        if (repo) mainPaths.add(repo);
        if (!isLinkedWorktree(cwd)) mainPaths.add(cwd);

        const [mainGroups, wtGroups] = await Promise.all([
          Promise.all(
            [...mainPaths].map((p) =>
              SessionManager.list(p, undefined, progress).catch(
                () => [] as Awaited<ReturnType<typeof SessionManager.list>>,
              ),
            ),
          ),
          Promise.all(
            worktrees.map((wt) =>
              SessionManager.list(wt, undefined, progress).catch(
                () => [] as Awaited<ReturnType<typeof SessionManager.list>>,
              ),
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
          .filter((s) => {
            if (seen.has(s.path)) return false;
            seen.add(s.path);
            return true;
          })
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
      await Effect.runPromise(launchEffect(process.cwd(), ["--session", selectedPath, ...piArgs], sandbox));
      return null;
    }
    return { sessionFile: selectedPath, meta: pitEntry.data };
  } catch {
    return null;
  }
}

// ── cleanup helper ────────────────────────────────────────────────────────────

const unlinkSilent = (p: string): Effect.Effect<void, never, never> =>
  Effect.sync(() => { try { fs.unlinkSync(p); } catch { /* already gone */ } });

// ── dispatch ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

const program = Effect.gen(function* () {
  const { sandbox, noTree, filteredArgv } = parseFlags(argv);

  // ── pi subcommands: forward directly ───────────────────────────────────
  if (filteredArgv.length > 0 && PI_SUBCOMMANDS.has(filteredArgv[0])) {
    const r = spawnSync("pi", filteredArgv, { stdio: "inherit", shell: false });
    process.exit(r.status ?? 0);
  }

  // ── info-only flags: skip worktree, pass straight to pi ────────────────
  if (filteredArgv.some((f) => INFO_ONLY_FLAGS.has(f))) {
    yield* launchEffect(process.cwd(), filteredArgv, false);
    return;
  }

  // ── pit -r [id]: worktree-aware resume picker ───────────────────────────
  if (filteredArgv[0] === "-r" || filteredArgv[0] === "--resume") {
    const piArgs = filteredArgv.slice(1);
    const picked = yield* Effect.promise(() => showPicker(piArgs, sandbox));
    if (!picked) return;

    const result = yield* worktreeCheckEffect(picked.meta);
    const sandboxMounts = resolveSandboxMounts(result.cwd, sandbox);
    const settingsPath = yield* createTempSettingsFileEffect(AGENT_DIR, readPitConfig(PIT_DIR));

    const socketOpt = yield* startPitEscapeEffect(result.cwd, result.meta.id, settingsPath);
    if (Option.isSome(socketOpt)) process.env.PIT_ESCAPE_SOCKET = socketOpt.value;

    yield* launchEffect(
      result.cwd,
      ["--session", picked.sessionFile, ...extensionArgs(), ...systemPromptArgs(result.meta, sandboxMounts), ...piArgs],
      sandbox,
      settingsPath,
    );
    yield* unlinkSilent(settingsPath);
    return;
  }

  const userManagingSession = filteredArgv.some((f) => SESSION_FLAGS.has(f));

  // ── already inside a linked worktree ───────────────────────────────────
  if (!noTree && isLinkedWorktree(process.cwd())) {
    const cwd = process.cwd();
    if (userManagingSession) {
      yield* launchEffect(cwd, filteredArgv, sandbox);
      return;
    }
    const sandboxMounts = resolveSandboxMounts(cwd, sandbox);
    const session = yield* findOrCreateLinkedSessionEffect(cwd, AGENT_DIR, sandboxMounts);
    if (session.kind === "new") {
      console.error("pit: already in a git worktree — no pit session found, running no-tree");
    }
    const settingsPath = yield* createTempSettingsFileEffect(AGENT_DIR, readPitConfig(PIT_DIR));
    const socketOpt = yield* startPitEscapeEffect(cwd, session.meta.id, settingsPath);
    if (Option.isSome(socketOpt)) process.env.PIT_ESCAPE_SOCKET = socketOpt.value;

    yield* launchEffect(
      cwd,
      ["--session", session.sessionFile, ...extensionArgs(), ...systemPromptArgs(session.meta, sandboxMounts), ...filteredArgv],
      sandbox,
      settingsPath,
    );
    yield* unlinkSilent(settingsPath);
    return;
  }

  // ── new session (or user-managed session) ───────────────────────────────
  const result = yield* worktreeCheckEffect(undefined, noTree);
  const settingsPath = yield* createTempSettingsFileEffect(AGENT_DIR, readPitConfig(PIT_DIR));

  const socketOpt = yield* startPitEscapeEffect(result.cwd, result.meta.id, settingsPath);
  if (Option.isSome(socketOpt)) process.env.PIT_ESCAPE_SOCKET = socketOpt.value;

  let piArgs: string[];
  if (userManagingSession) {
    piArgs = filteredArgv;
  } else {
    const sandboxMounts = resolveSandboxMounts(result.cwd, sandbox);
    const sessionFile = setupNewSession(result, AGENT_DIR, sandboxMounts);
    piArgs = [
      "--session", sessionFile,
      ...extensionArgs(),
      ...systemPromptArgs(result.meta, sandboxMounts),
      ...filteredArgv,
    ];
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
  ),
).catch((err: unknown) => {
  console.error(`pit: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
