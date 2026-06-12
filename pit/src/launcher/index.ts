/**
 * Launcher — everything pit needs to start pi (sandboxed or not) and the
 * pit-escape out-of-sandbox helper.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { layer as NodeContextLayer, type NodeContext } from "../node-context.ts";
import { main } from "@earendil-works/pi-coding-agent";
import type { PitMetadata, PitConfig, SandboxMounts, OverlayMount } from "../types.ts";
import { HOME, AGENT_DIR, PIT_DIR } from "../core/constants.ts";
import {
  resolveMainRepo,
  resolveWorktreeGitRwMounts,
} from "../core/git/utils.ts";
import { resolveUnversionedDirs } from "../core/sandbox/io.ts";
import { buildSandboxMountSpec, buildSandboxEnv, nonSandboxExtensionFlags } from "../core/sandbox/pure.ts";
import { buildSbplProfile } from "../core/sandbox/sbpl.ts";
import { probeSocketEffect } from "../extensions/escape/client.ts";
import { setPitEscapeSocket } from "../env.ts";
import { createExtensionFactories } from "../extensions/index.ts";
import { SocketAliveError } from "../errors.ts";

// ── sandbox helpers ───────────────────────────────────────────────────────────

export const findBwrap = (): string | null =>
  (process.env.PATH ?? "")
    .split(":")
    .map(d => join(d, "bwrap"))
    .find(p => existsSync(p)) ?? null;

export const findSandboxExec = (): string | null =>
  process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")
    ? "/usr/bin/sandbox-exec"
    : null;

/** Returns which sandbox backend is available on this platform, or null. */
export const findSandboxTool = (): { kind: "bwrap"; path: string } | { kind: "sandbox-exec" } | null => {
  if (process.platform === "darwin") {
    return existsSync("/usr/bin/sandbox-exec") ? { kind: "sandbox-exec" } : null;
  }
  const bwrapPath = findBwrap();
  return bwrapPath ? { kind: "bwrap", path: bwrapPath } : null;
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
 * On macOS: no overlay support (feature gap — sandbox-exec has no overlayfs).
 * resolveUnversionedDirs failure → warns + skips overlays (Linux only).
 * resolveWorktreeGitRwMounts failure → empty mounts (caller sees typed error).
 */
export const buildSandboxMountsEffect = (
  cwd: string,
  agentDir: string,
  extensionMounts: string[],
  nodeDir: string,
  pitConfig?: Readonly<PitConfig>,
): Effect.Effect<SandboxMounts, never, NodeContext> =>
  Effect.gen(function* () {
    const platform = process.platform === "darwin" ? "darwin" as const : "linux" as const;
    const parentRepo = yield* resolveMainRepo(cwd);
    const overlayDirs = platform === "linux" && parentRepo
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
          } catch { return []; }
        })
      : [];
    const gitRwMounts = yield* resolveWorktreeGitRwMounts(cwd);
    return buildSandboxMountSpec({
      home: HOME, cwd, agentDir, extensionMounts, nodeDir,
      gitRwMounts, overlayDirs, platform, pitConfig,
    });
  });

export const resolveSandboxMountsEffect = (
  cwd: string,
  useSandbox: boolean,
  pitConfig?: Readonly<PitConfig>,
): Effect.Effect<SandboxMounts | undefined, never, NodeContext> =>
  Effect.gen(function* () {
    if (!useSandbox || !findSandboxTool()) return undefined;
    const nodeDir = dirname(dirname(process.execPath));
    return yield* buildSandboxMountsEffect(
      cwd, realpathSync(AGENT_DIR), getExtensionMounts(), nodeDir, pitConfig,
    );
  });

// ── bwrap launch ──────────────────────────────────────────────────────────────

/**
 * Build the shared bwrap argument array (everything before the -- separator).
 * Used by bwrapLaunch for production and by test helpers for sandbox probes.
 */
export const buildBwrapArgs = (
  mounts: Readonly<SandboxMounts>,
  opts: Readonly<{
    cwd: string;
    /** Required for pit mount resolution. Omit if running an arbitrary script. */
    scriptPath?: string;
  }>,
): string[] => {
  const roArgs = mounts.ro.flatMap(m =>
    [m.optional ? "--ro-bind-try" : "--ro-bind", m.path, m.path],
  );
  const rwArgs = mounts.rw.flatMap(m => [m.optional ? "--bind-try" : "--bind", m.path, m.path]);
  const overlayArgs = (mounts.overlay ?? []).flatMap(m => {
    mkdirSync(m.dest, { recursive: true });
    return ["--overlay-src", m.src, "--tmp-overlay", m.dest];
  });

  const pitMounts = opts.scriptPath ? resolvePitMounts(opts.scriptPath, opts.cwd) : null;
  const dynamicMountArgs = pitMounts
    ? ["--ro-bind", pitMounts.pitSrcDir, pitMounts.pitSrcDir,
       "--ro-bind", pitMounts.pitNodeModules, pitMounts.pitNodeModules]
    : [];

  return [
    "--tmpfs", "/", "--dev", "/dev", "--proc", "/proc",
    ...roArgs, ...rwArgs, ...overlayArgs, ...dynamicMountArgs,
    "--unshare-user", "--unshare-pid", "--die-with-parent",
    "--chdir", opts.cwd,
  ];
};

/**
 * Resolve the pit source directory and its node_modules for mounting.
 * Returns null when running from a globally-installed path (already mounted).
 */
const resolvePitMounts = (scriptPath: string, cwd: string): { pitSrcDir: string; pitNodeModules: string } | null => {
  const scriptDir = resolve(dirname(scriptPath));
  if (scriptDir.includes("/lib/node_modules/")) return null;
  
  // If the script is physically located inside the current working directory,
  // it is already covered by the read-write workspace mount. Adding a ro-bind
  // here would prevent the agent from developing pit itself.
  if (scriptDir.startsWith(cwd)) return null;

  // Mount the entire pit/src directory, not just pit/src/launcher
  const pitSrcDir = resolve(scriptDir, "..");
  
  const findNm = (curr: string): string | null => {
    const nm = join(curr, "node_modules");
    if (existsSync(nm)) return nm;
    const up = dirname(curr);
    return up === curr ? null : findNm(up);
  };
  const pitNodeModules = findNm(pitSrcDir);
  return pitNodeModules ? { pitSrcDir, pitNodeModules } : null;
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
  pitConfig: Readonly<PitConfig>,
  escapeToken?: string,
): never => {
  const bwrap = findBwrap()!;
  const nodeBin = process.execPath;
  const scriptPath = process.argv[1]!;
  const pitInnerScript = resolve(dirname(scriptPath), "src", "launcher", "inner.ts");

  const env = buildSandboxEnv(pitConfig, process.env as Record<string, string | undefined>, escapeToken);
  const envArgs: string[] = [
    "--clearenv",
    ...Object.entries(env).flatMap(([k, v]) => ["--setenv", k, v]),
  ];

  const args: Readonly<string[]> = [
    ...buildBwrapArgs(mounts, { cwd, scriptPath }),
    ...envArgs,
    "--", nodeBin, "--experimental-strip-types", pitInnerScript, ...piArgs,
  ];

  const result = spawnSync(bwrap, args, { stdio: "inherit" });
  process.exit(result.status ?? 1);
};

// ── macOS sandbox-exec launch ─────────────────────────────────────────────────────

/**
 * Spawn the sandboxed pi session via macOS sandbox-exec.
 * Uses spawn (async) so SIGTERM/SIGINT can be forwarded to the child.
 * Note: SIGKILL of pit orphans the child — accepted risk, same as ASRT.
 * Effectively never returns (calls process.exit on child exit).
 */
export const sbplLaunch = (
  cwd: string,
  piArgs: Readonly<string[]>,
  mounts: Readonly<SandboxMounts>,
  pitConfig: Readonly<PitConfig>,
  escapeToken?: string,
): Promise<never> => {
  const nodeBin = process.execPath;
  const scriptPath = process.argv[1]!;
  const pitInnerScript = resolve(dirname(scriptPath), "src", "launcher", "inner.ts");

  // Resolve rw paths to real (symlink-free) paths — SBPL matches on real paths.
  const resolvedMounts: SandboxMounts = {
    ...mounts,
    rw: mounts.rw.map(m => {
      try { return { ...m, path: realpathSync(m.path) }; }
      catch { return m; } // path doesn't exist yet, use as-is
    }),
  };

  const profile = buildSbplProfile(resolvedMounts);
  const env = buildSandboxEnv(pitConfig, process.env as Record<string, string | undefined>, escapeToken);

  const child = spawn(
    "/usr/bin/sandbox-exec",
    ["-p", profile, "--", nodeBin, "--experimental-strip-types", pitInnerScript, ...piArgs],
    { stdio: "inherit", env, cwd },
  );

  const sigterm = () => { try { child.kill("SIGTERM"); } catch { /* gone */ } };
  const sigint  = () => { try { child.kill("SIGINT");  } catch { /* gone */ } };
  process.on("SIGTERM", sigterm);
  process.on("SIGINT",  sigint);

  return new Promise<never>((_, reject) => {
    child.on("error", (err) => {
      process.off("SIGTERM", sigterm);
      process.off("SIGINT",  sigint);
      reject(err);
    });
    child.on("exit", (code) => {
      process.off("SIGTERM", sigterm);
      process.off("SIGINT",  sigint);
      process.exit(code ?? 1);
    });
  });
};

export const launchEffect = (
  cwd: string,
  piArgs: string[],
  sandbox: boolean,
  mounts?: SandboxMounts,
  pitConfig?: PitConfig,
  escapeHandle?: EscapeHandle,
): Effect.Effect<void, never, NodeContext> =>
  Effect.gen(function* () {
    if (sandbox) {
      const tool = findSandboxTool();
      if (tool?.kind === "sandbox-exec") {
        const m = mounts ?? (yield* buildSandboxMountsEffect(
          cwd, realpathSync(AGENT_DIR), getExtensionMounts(),
          dirname(dirname(process.execPath)), pitConfig,
        ));
        // sbplLaunch exits the process; promise never resolves
        yield* Effect.promise(() =>
          sbplLaunch(cwd, piArgs, m, pitConfig ?? {}, escapeHandle?.token)
        );
        return;
      }
      if (tool?.kind === "bwrap") {
        const m = mounts ?? (yield* buildSandboxMountsEffect(
          cwd, realpathSync(AGENT_DIR), getExtensionMounts(),
          dirname(dirname(process.execPath)), pitConfig,
        ));
        bwrapLaunch(cwd, piArgs, m, pitConfig ?? {}, escapeHandle?.token); // never returns
      }
      yield* Effect.logWarning(
        process.platform === "darwin"
          ? "pit: sandbox-exec not found — running without sandbox"
          : "pit: bwrap not found — running without sandbox",
      );
    }
    // Non-sandbox: pass the same factories so extension behaviour is consistent.
    // Also pass nonSandboxExtensions from pit config as --extension flags.
    const socketPath = escapeHandle?.socketPath ?? "";
    const token = escapeHandle?.token ?? "";
    const extFlags = nonSandboxExtensionFlags(pitConfig);
    process.chdir(cwd);
    yield* Effect.promise(() =>
      main([...piArgs, ...extFlags], {
        extensionFactories: createExtensionFactories(socketPath, token, false),
      }).catch(() => {})
    );
  });

// ── pit-escape startup ────────────────────────────────────────────────────────

export type EscapeHandle = { socketPath: string; token: string };

export const startPitEscapeEffect = (
  worktreeCwd: string,
  sessionId: string,
): Effect.Effect<Option.Option<EscapeHandle>, SocketAliveError, NodeContext> =>
  Effect.gen(function* () {
    // Escape server starts whenever sandboxed — individual ops
    // (merge, subscribe) fail gracefully when cwd is not a linked worktree.
    const socketPath = join(AGENT_DIR, `pit-${sessionId}.sock`);
    const probe = yield* probeSocketEffect(socketPath);
    if (probe === "alive") return yield* Effect.fail(new SocketAliveError({ sessionId }));

    yield* Effect.sync(() => { try { unlinkSync(socketPath); } catch { /* gone */ } });

    const token = randomUUID();
    const scriptDir = resolve(dirname(process.argv[1]));
    const escapeScript = join(scriptDir, "src", "escape", "server.ts");

    return yield* Effect.async<Option.Option<EscapeHandle>>((resume) => {
      const child = spawn(
        process.execPath,
        [
          "--experimental-strip-types", escapeScript,
          token, socketPath, worktreeCwd, realpathSync(AGENT_DIR), PIT_DIR,
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );

      const killEscape = () => {
        try { child.kill("SIGTERM"); } catch { /* gone */ }
        try { unlinkSync(socketPath); } catch { /* gone */ }
      };
      process.on("exit", killEscape);
      process.on("SIGTERM", () => { killEscape(); process.exit(1); });
      process.on("SIGINT",  () => { killEscape(); process.exit(130); });

      const timer = setTimeout(() => {
        child.unref();
        resume(
          Effect.logWarning("pit: pit-escape timed out — git tool and settings refresh unavailable").pipe(
            Effect.as(Option.none<EscapeHandle>()),
          ),
        );
      }, 3000);

      child.stdout!.once("data", () => {
        clearTimeout(timer);
        child.stdout!.destroy(); // release the pipe
        child.unref(); // don't keep pit's event loop alive for the background escape server
        resume(Effect.succeed(Option.some({ socketPath, token })));
      });
      child.once("error", (err) => {
        clearTimeout(timer);
        child.unref();
        resume(
          Effect.logWarning(`pit: pit-escape: ${err.message}`).pipe(
            Effect.as(Option.none<EscapeHandle>()),
          ),
        );
      });
      child.once("exit", (code) => { if (code !== 0) { clearTimeout(timer); resume(Effect.succeed(Option.none())); } });
    });
  });
