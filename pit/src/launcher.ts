/**
 * Launcher — everything pit needs to start pi (sandboxed or not) and the
 * pit-escape out-of-sandbox helper.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execSync, spawnSync, spawn } from "node:child_process";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { layer as NodeContextLayer, type NodeContext } from "@effect/platform-node/NodeContext";
import { main } from "@earendil-works/pi-coding-agent";
import type { PitMetadata, SandboxMounts, OverlayMount } from "./types.ts";
import { HOME, AGENT_DIR, PIT_DIR } from "./core/constants.ts";
import {
  isLinkedWorktree,
  resolveMainRepo,
  resolveWorktreeGitRwMounts,
} from "./core/git/utils.ts";
import { resolveUnversionedDirs } from "./core/sandbox/io.ts";
import { buildSandboxMountSpec } from "./core/sandbox/pure.ts";
import { probeSocketEffect } from "./extensions/escape/client.ts";
import { SocketAliveError } from "./errors.ts";

// ── extension args ────────────────────────────────────────────────────────────

export const extensionArgs = (): string[] => {
  const d = resolve(dirname(process.argv[1]));
  return [
    join(d, "src", "extensions", "hooks", "reload.ts"),
    join(d, "src", "extensions", "tools", "git.ts"),
    join(d, "src", "extensions", "commands", "merge", "index.ts"),
    join(d, "src", "extensions", "status", "loc-diff.ts"),
    join(d, "src", "extensions", "status", "merge-status.ts"),
    join(d, "src", "extensions", "commands", "rename-branch", "index.ts"),
  ].flatMap((f) => ["--extension", f]);
};

// ── sandbox helpers ───────────────────────────────────────────────────────────

export const findBwrap = (): string | null => {
  return ["/usr/bin/bwrap", "/usr/local/bin/bwrap"].find(p => existsSync(p)) ?? null;
};

const findNodeModules = (dir: string): string | null => {
  const nm = join(dir, "node_modules");
  if (existsSync(nm)) return nm;
  const up = dirname(dir);
  return up === dir ? null : findNodeModules(up);
};

export const getExtensionMounts = (): string[] => {
  const settingsFile = join(AGENT_DIR, "settings.json");
  if (!existsSync(settingsFile)) return [];
  const settings = (() => {
    try {
      const raw = readFileSync(settingsFile, "utf8");
      if (!raw.trim()) return null;
      return JSON.parse(raw) as { extensions?: string[] };
    } catch { return null; }
  })();
  if (!settings) return [];
  return [...new Set(
    (settings.extensions ?? [])
      .filter(ext => existsSync(ext))
      .flatMap(ext => {
        const nm = findNodeModules(dirname(ext));
        return nm ? [ext, nm] : [ext];
      }),
  )].sort();
};

/**
 * Build sandbox mounts.
 * resolveUnversionedDirs failure → warns + skips overlays (graceful degradation).
 * resolveWorktreeGitRwMounts failure → empty mounts (caller sees typed error).
 */
export const buildSandboxMountsEffect = (
  cwd: string,
  agentDirReal: string,
  extensionMounts: string[],
  nodeDir: string,
): Effect.Effect<SandboxMounts, never, NodeContext> =>
  Effect.gen(function* () {
    const parentRepo = yield* resolveMainRepo(cwd);
    const overlayDirs = parentRepo
      ? (yield* resolveUnversionedDirs(parentRepo).pipe(
          Effect.catchAll((e) =>
            Effect.logWarning(`pit: overlay mounts unavailable: ${String(e)}`).pipe(
              Effect.as([] as string[]),
            ),
          ),
        )).flatMap(rel => {
          const src = join(parentRepo, rel);
          const dest = join(cwd, rel);
          try {
            if (!statSync(src).isDirectory()) return [];
            if (existsSync(dest) && statSync(dest).isDirectory() && readdirSync(dest).length > 0)
              return [];
            return [{ src, dest, label: rel }];
          } catch { return []; } // src disappeared
        })
      : [];
    const gitRwMounts = yield* resolveWorktreeGitRwMounts(cwd);
    return buildSandboxMountSpec({
      home: HOME, cwd, agentDirReal, extensionMounts, nodeDir, gitRwMounts, overlayDirs,
    });
  });

export const resolveSandboxMountsEffect = (
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

// ── bwrap launch ──────────────────────────────────────────────────────────────

const shadowAgentMountArgs = (agentDirReal: string, settingsPath: string): string[] => {
  return [
    "--bind", agentDirReal, "/pit-agent",
    "--bind", settingsPath, "/pit-agent/settings.json",
  ];
};

/**
 * Spawn the sandboxed pi session via bwrap.
 * Mounts are pre-computed by the Effect pipeline and passed in.
 * Never returns — exits the process.
 */
export const bwrapLaunch = (
  cwd: string,
  piArgs: Readonly<string[]>,
  mounts: Readonly<SandboxMounts>,
  settingsPath?: string,
): never => {
  const bwrap = findBwrap()!;
  const nodeBin = process.execPath;
  const nodeDir = dirname(dirname(nodeBin));
  const piScript = realpathSync(execSync("which pi", { encoding: "utf8" }).trim());

  const roArgs = mounts.ro.flatMap(m =>
    [m.optional ? "--ro-bind-try" : "--ro-bind", m.path, m.path],
  );
  const rwArgs = mounts.rw.flatMap(m => ["--bind", m.path, m.path]);
  const overlayArgs = (mounts.overlay ?? []).flatMap(m => {
    mkdirSync(m.dest, { recursive: true });
    return ["--overlay-src", m.src, "--tmp-overlay", m.dest];
  });
  const mountArgs = [...roArgs, ...rwArgs, ...overlayArgs];

  const agentDirReal = realpathSync(AGENT_DIR);
  const shadowArgs = settingsPath ? shadowAgentMountArgs(agentDirReal, settingsPath) : [];
  const agentDirEnv = settingsPath ? ["--setenv", "PI_CODING_AGENT_DIR", "/pit-agent"] : [];

  const args: Readonly<string[]> = [
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
};

export const launchEffect = (
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
      yield* Effect.logWarning("pit: bwrap not found — running without sandbox");
    }
    process.chdir(cwd);
    yield* Effect.promise(() => main(piArgs).catch(() => {}));
  });

// ── pit-escape startup ────────────────────────────────────────────────────────

export const startPitEscapeEffect = (
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
    const escapeScript = join(scriptDir, "src", "escape", "server.ts");

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
        resume(
          Effect.logWarning("pit: pit-escape timed out — git tool and settings refresh unavailable").pipe(
            Effect.as(Option.none<string>()),
          ),
        );
      }, 3000);

      child.stdout!.once("data", () => { clearTimeout(timer); resume(Effect.succeed(Option.some(socketPath))); });
      child.once("error", (err) => {
        clearTimeout(timer);
        resume(
          Effect.logWarning(`pit: pit-escape: ${err.message}`).pipe(
            Effect.as(Option.none<string>()),
          ),
        );
      });
      child.once("exit", (code) => { if (code !== 0) { clearTimeout(timer); resume(Effect.succeed(Option.none())); } });
    });
  });
