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
import { layer as NodeContextLayer, type NodeContext } from "@effect/platform-node/NodeContext";
import { main } from "@earendil-works/pi-coding-agent";
import type { PitMetadata, PitConfig, SandboxMounts, OverlayMount } from "./types.ts";
import { HOME, AGENT_DIR, PIT_DIR } from "./core/constants.ts";
import {
  isLinkedWorktree,
  resolveMainRepo,
  resolveWorktreeGitRwMounts,
} from "./core/git/utils.ts";
import { resolveUnversionedDirs } from "./core/sandbox/io.ts";
import { buildSandboxMountSpec, allowedEnvArgs } from "./core/sandbox/pure.ts";
import { probeSocketEffect } from "./extensions/escape/client.ts";
import { setPitEscapeSocket, setPitEscapeToken } from "./env.ts";
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

// ── dynamic pit mounts ─────────────────────────────────────────────────────────────

/**
 * Resolve the pit source directory and its node_modules for mounting.
 * Returns null when running from a globally-installed path (already mounted).
 */
const resolvePitMounts = (scriptPath: string): { pitDir: string; pitNodeModules: string } | null => {
  const scriptDir = resolve(dirname(scriptPath));
  if (scriptDir.includes("/lib/node_modules/")) return null;
  const pitDir = scriptDir;
  const findNm = (curr: string): string | null => {
    const nm = join(curr, "node_modules");
    if (existsSync(nm)) return nm;
    const up = dirname(curr);
    return up === curr ? null : findNm(up);
  };
  const pitNodeModules = findNm(pitDir);
  return pitNodeModules ? { pitDir, pitNodeModules } : null;
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
  settingsPath?: string,
  escapeToken?: string,
): never => {
  const bwrap = findBwrap()!;
  const nodeBin = process.execPath;
  const nodeDir = dirname(dirname(nodeBin));
  const scriptPath = process.argv[1]!;
  const pitInnerScript = resolve(dirname(scriptPath), "src", "inner.ts");

  const roArgs = mounts.ro.flatMap(m =>
    [m.optional ? "--ro-bind-try" : "--ro-bind", m.path, m.path],
  );
  const rwArgs = mounts.rw.flatMap(m => ["--bind", m.path, m.path]);
  const overlayArgs = (mounts.overlay ?? []).flatMap(m => {
    mkdirSync(m.dest, { recursive: true });
    return ["--overlay-src", m.src, "--tmp-overlay", m.dest];
  });

  const pitMounts = resolvePitMounts(scriptPath);
  const dynamicMountArgs = pitMounts
    ? ["--ro-bind", pitMounts.pitDir, pitMounts.pitDir,
       "--ro-bind", pitMounts.pitNodeModules, pitMounts.pitNodeModules]
    : [];

  const mountArgs = [...roArgs, ...rwArgs, ...overlayArgs, ...dynamicMountArgs];

  const agentDirReal = realpathSync(AGENT_DIR);
  const shadowArgs = settingsPath ? shadowAgentMountArgs(agentDirReal, settingsPath) : [];
  const agentDirEnv = settingsPath ? ["--setenv", "PI_CODING_AGENT_DIR", "/pit-agent"] : [];

  const envArgs: string[] = [
    "--clearenv",
    "--setenv", "HOME", HOME,
    "--setenv", "PATH", `${nodeDir}/bin:/usr/local/bin:/usr/bin:/bin`,
    "--setenv", "PI_CODING_AGENT", "true",
    "--setenv", "PIT_IS_INNER", "1",
    ...(process.env.TERM ? ["--setenv", "TERM", process.env.TERM] : []),
    ...(process.env.LANG ? ["--setenv", "LANG", process.env.LANG] : []),
    ...(process.env.PIT_ESCAPE_SOCKET
      ? ["--setenv", "PIT_ESCAPE_SOCKET", process.env.PIT_ESCAPE_SOCKET]
      : []),
    ...(escapeToken ? ["--setenv", "PIT_ESCAPE_TOKEN", escapeToken] : []),
    ...allowedEnvArgs(pitConfig, process.env as Record<string, string | undefined>),
  ];

  const args: Readonly<string[]> = [
    "--tmpfs", "/", "--dev", "/dev", "--proc", "/proc",
    ...mountArgs, ...shadowArgs,
    "--unshare-user", "--unshare-pid", "--die-with-parent",
    ...envArgs,
    ...agentDirEnv,
    "--chdir", cwd,
    "--", nodeBin, "--experimental-strip-types", pitInnerScript, ...piArgs,
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
  pitConfig?: PitConfig,
  escapeToken?: string,
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
        bwrapLaunch(cwd, piArgs, m, pitConfig ?? {}, settingsPath, escapeToken); // never returns
      }
      yield* Effect.logWarning("pit: bwrap not found — running without sandbox");
    }
    if (escapeToken) setPitEscapeToken(escapeToken);
    process.chdir(cwd);
    yield* Effect.promise(() => main(piArgs).catch(() => {}));
  });

// ── pit-escape startup ────────────────────────────────────────────────────────

export type EscapeHandle = { socketPath: string; token: string };

export const startPitEscapeEffect = (
  worktreeCwd: string,
  sessionId: string,
  settingsPath: string,
): Effect.Effect<Option.Option<EscapeHandle>, SocketAliveError, NodeContext> =>
  Effect.gen(function* () {
    const isMain = yield* isLinkedWorktree(worktreeCwd).pipe(
      Effect.map((linked) => !linked),
    );
    if (isMain) return Option.none();

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
          token, socketPath, worktreeCwd, realpathSync(AGENT_DIR), PIT_DIR, settingsPath,
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
            Effect.as(Option.none<EscapeHandle>()),
          ),
        );
      }, 3000);

      child.stdout!.once("data", () => { clearTimeout(timer); resume(Effect.succeed(Option.some({ socketPath, token }))); });
      child.once("error", (err) => {
        clearTimeout(timer);
        resume(
          Effect.logWarning(`pit: pit-escape: ${err.message}`).pipe(
            Effect.as(Option.none<EscapeHandle>()),
          ),
        );
      });
      child.once("exit", (code) => { if (code !== 0) { clearTimeout(timer); resume(Effect.succeed(Option.none())); } });
    });
  });
