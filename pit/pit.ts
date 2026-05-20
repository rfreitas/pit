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
import { worktreeCheck } from "./worktree/io.ts";
import { systemPromptArgs, buildAnnouncement } from "./session/pure.ts";
import { setupNewSession, findOrCreateLinkedSession } from "./session/io.ts";
import { buildSandboxMountSpec, applyDenylist } from "./sandbox/pure.ts";
import { resolveUnversionedDirs, readPitConfig, createTempSettingsFile } from "./sandbox/io.ts";
import { probeSocket } from "./escape/client.ts";
import {
  isLinkedWorktree,
  resolveMainRepo,
  listRepoWorktrees,
  readWorktreeBranch,
  resolveWorktreeGitRwMounts,
  gitRepoRoot,
} from "./git/utils.ts";

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

// ── helpers ──────────────────────────────────────────────────────────────────

// ── session pre-seeding ───────────────────────────────────────────────────────

/**
 * Resolve sandbox mounts for a new session announcement.
 * Returns the mount list when bwrap is active, undefined otherwise.
 */
function resolveSandboxMounts(cwd: string, useSandbox: boolean): SandboxMounts | undefined {
  if (!useSandbox) return undefined;
  if (!findBwrap()) return undefined;
  const nodeDir = path.dirname(path.dirname(process.execPath));
  return buildSandboxMounts(cwd, fs.realpathSync(AGENT_DIR), getExtensionMounts(), nodeDir);
}

/**
 * Build --extension args pointing to pit's extension files.
 */
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

// ── pit dir ───────────────────────────────────────────────────────────────────

/** ~/.pi/agent/pit — inside the repo-tracked agent config dir */
const PIT_DIR = path.join(AGENT_DIR, "pit");

/**
 * Create a temp file containing filtered settings for this session.
 * Returns the path; caller must delete it after bwrap exits.
 */
function makeTempSettingsFile(): string {
  return createTempSettingsFile(AGENT_DIR, readPitConfig(PIT_DIR));
}

// ── pit-escape ────────────────────────────────────────────────────────────────

/**
 * Start pit-escape for this session.
 *
 * pit-escape runs OUTSIDE the bwrap sandbox with full host access. It handles
 * git operations (via the sandboxed git tool) and settings refresh (called by
 * the bundled reload extension on /reload).
 *
 * Returns the socket path (set as PIT_ESCAPE_SOCKET in the sandbox env), or
 * undefined if the helper fails to start or cwd is not a linked worktree.
 */
async function startPitEscape(
  worktreeCwd: string,
  sessionId: string,
  settingsPath: string
): Promise<string | undefined> {
  const gitFile = path.join(worktreeCwd, ".git");
  try {
    if (fs.statSync(gitFile).isDirectory()) return undefined; // main worktree, not linked
  } catch {
    return undefined; // not a git repo
  }

  const socketPath = path.join(AGENT_DIR, `pit-${sessionId}.sock`);

  // Probe before touching the socket: if a live pit-escape already owns it,
  // the user has this session open in another terminal — fail fast.
  const probe = await probeSocket(socketPath);
  if (probe === "alive") {
    console.error(
      `pit: session ${sessionId} is already open in another terminal.\n` +
      `     Exit that session first, or resume a different one.`
    );
    process.exit(1);
  }
  // stale or absent — safe to respawn
  try { fs.unlinkSync(socketPath); } catch { /* already gone */ }

  const scriptDir = path.resolve(path.dirname(process.argv[1]));
  const escapeScript = path.join(scriptDir, "escape", "server.ts");

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
    { stdio: ["ignore", "pipe", "inherit"] }
  );

  process.on("exit", () => {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    try { fs.unlinkSync(socketPath); } catch { /* already gone */ }
  });

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn("pit: pit-escape timed out — git tool and settings refresh unavailable");
      resolve(undefined);
    }, 3000);

    child.stdout!.once("data", () => { clearTimeout(timer); resolve(socketPath); });
    child.once("error", (err) => {
      clearTimeout(timer);
      console.warn(`pit: pit-escape: ${err.message}`);
      resolve(undefined);
    });
    child.once("exit", (code) => {
      if (code !== 0) { clearTimeout(timer); resolve(undefined); }
    });
  });
}

// ── resume via session picker ───────────────────────────────────────────────────────

/**
 * Show pi's native session picker directly via TUI + SessionSelectorComponent,
 * without launching a full pi session in the outer process. No session opens,
 * no cancel/shutdown gymnastics — just the picker UI, then a clean bwrap launch.
 *
 * If the user picks a pit session: return the selection for worktree check + relaunch.
 * If the user picks a non-pit session: open it normally via launch() and return null.
 * If the user cancels: return null.
 */
async function showPicker(
  piArgs: string[],
  sandbox: boolean
): Promise<{ sessionFile: string; meta: PitMetadata } | null> {
  const { TUI, ProcessTerminal } = await import("@earendil-works/pi-tui");
  initTheme();

  const selectedPath = await new Promise<string | null>((resolve) => {
    const terminal = new ProcessTerminal();
    const tui = new TUI(terminal, true);

    const selector = new SessionSelectorComponent(
      async (progress) => {
        // Collect sessions from the main repo and all linked worktrees.
        // Keep them separate so we know which sessions came from which worktree
        // without needing to inspect s.cwd after the fact.
        //
        // When pit -r is invoked from inside a linked worktree, gitRepoRoot()
        // returns the worktree directory (git's --show-toplevel is worktree-scoped).
        // We need the actual main repo so listRepoWorktrees includes the current
        // worktree and it gets labelled correctly.
        const cwd = process.cwd();
        const rawRepo = gitRepoRoot();
        const repo = (rawRepo && isLinkedWorktree(cwd))
          ? (resolveMainRepo(cwd) ?? rawRepo)
          : rawRepo;
        const worktrees = repo ? listRepoWorktrees(repo) : [];

        // Read each worktree's branch once upfront — one fs read per worktree.
        // Falls back to "deleted" when the directory no longer exists.
        const worktreeBranch = new Map(
          worktrees.map((wt) => [wt, readWorktreeBranch(wt) ?? "deleted"])
        );

        // When invoking from a linked worktree, cwd is itself a worktree and
        // will be covered by the worktrees list — don't add it to mainPaths or
        // it ends up in mainGroups without a label.
        const mainPaths = new Set<string>();
        if (repo) mainPaths.add(repo);
        if (!isLinkedWorktree(cwd)) mainPaths.add(cwd);

        const [mainGroups, wtGroups] = await Promise.all([
          Promise.all(
            [...mainPaths].map((p) =>
              SessionManager.list(p, undefined, progress).catch(() => [] as Awaited<ReturnType<typeof SessionManager.list>>)
            )
          ),
          Promise.all(
            worktrees.map((wt) =>
              SessionManager.list(wt, undefined, progress).catch(() => [] as Awaited<ReturnType<typeof SessionManager.list>>)
            )
          ),
        ]);

        // Mark each worktree session: prefix label into name (if set) or
        // firstMessage (if not), so the label is always visible and the
        // named filter is unaffected.
        const label = (branch: string) => `[worktree branch:${branch}]`;
        const marked = worktrees.flatMap((wt, i) =>
          wtGroups[i].map((s) => {
            const l = label(worktreeBranch.get(wt)!);
            return s.name
              ? { ...s, name: `${l} ${s.name}` }
              : { ...s, firstMessage: `${l} ${s.firstMessage}` };
          })
        );

        // Merge, deduplicate, and sort by most-recently-modified so Recent
        // mode shows a correctly interleaved timeline across all paths.
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
      (sessionPath) => { tui.stop(); resolve(sessionPath); }, // onSelect
      () => { tui.stop(); resolve(null); },                   // onCancel
      () => { tui.stop(); resolve(null); },                   // onExit
      () => tui.requestRender(),
    );

    tui.start();
    tui.addChild(selector);
    tui.setFocus(selector);
  });

  if (!selectedPath) return null;

  // Check if the selected session is a pit session
  try {
    const sm = SessionManager.open(selectedPath);
    const pitEntry = sm.getEntries().find(
      (e): e is CustomEntry<PitMetadata> =>
        e.type === "custom" && (e as CustomEntry).customType === "pit"
    );
    if (!pitEntry?.data) {
      // Non-pit session — open normally without worktree management
      await launch(process.cwd(), ["--session", selectedPath, ...piArgs], sandbox);
      return null;
    }
    return { sessionFile: selectedPath, meta: pitEntry.data };
  } catch {
    return null;
  }
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

/**
 * Collect IO inputs and delegate to the pure buildSandboxMountSpec.
 */
function buildSandboxMounts(cwd: string, agentDirReal: string, extensionMounts: string[], nodeDir: string): SandboxMounts {
  const overlayDirs: OverlayMount[] = [];
  const parentRepo = resolveMainRepo(cwd);
  if (parentRepo) {
    for (const rel of resolveUnversionedDirs(parentRepo)) {
      const src = path.join(parentRepo, rel);
      const dest = path.join(cwd, rel);
      try {
        if (fs.statSync(src).isDirectory()) overlayDirs.push({ src, dest, label: rel });
      } catch { /* src disappeared — skip */ }
    }
  }
  return buildSandboxMountSpec({
    home: HOME, cwd, agentDirReal, extensionMounts, nodeDir,
    gitRwMounts: resolveWorktreeGitRwMounts(cwd),
    overlayDirs,
  });
}

/**
 * Build bwrap args for the shadow agent dir — a view of ~/.pi/agent inside the
 * sandbox where only settings.json is replaced with the pit-filtered version.
 *
 * The agent dir is bound rw (not ro) so proper-lockfile can create lock files
 * next to auth.json. Writing to settings.json goes to the filtered host-side
 * file (the later bind wins), not to the real ~/.pi/agent/settings.json.
 */
function shadowAgentMountArgs(agentDirReal: string, settingsPath: string): string[] {
  return [
    // rw bind: lock files (auth.json.lock etc.) need a writable directory.
    "--bind", agentDirReal, "/pit-agent",
    // Override settings.json with the filtered version.
    // Later mount wins — writes go to filteredSettingsPath, not the real settings.
    "--bind", settingsPath, "/pit-agent/settings.json",
  ];
}

/**
 * Spawn the sandboxed pi session via bwrap.
 * The outer process handles all worktree/session setup; bwrap only wraps
 * the actual pi session. Never returns — exits the process.
 */
function bwrapLaunch(cwd: string, piArgs: string[], settingsPath?: string): never {
  const bwrap = findBwrap()!; // caller checks first
  const nodeBin = process.execPath;
  const nodeDir = path.dirname(path.dirname(nodeBin));
  const piScript = fs.realpathSync(
    execSync("which pi", { encoding: "utf8" }).trim()
  );

  const agentDirReal = fs.realpathSync(AGENT_DIR);
  const mounts = buildSandboxMounts(cwd, agentDirReal, getExtensionMounts(), nodeDir);
  const mountArgs: string[] = [];
  for (const m of mounts.ro) {
    mountArgs.push(m.optional ? "--ro-bind-try" : "--ro-bind", m.path, m.path);
  }
  for (const m of mounts.rw) {
    mountArgs.push("--bind", m.path, m.path);
  }
  // Overlay mounts come after the rw worktree bind so the overlay takes
  // precedence over the (empty) subdirectory that the rw bind exposed.
  // Syntax: --overlay-src <lower> --tmp-overlay <dest>
  for (const m of mounts.overlay ?? []) {
    // bwrap requires the dest to exist as a directory at mount time.
    // Create it on the real filesystem; it becomes the mount point.
    fs.mkdirSync(m.dest, { recursive: true });
    mountArgs.push("--overlay-src", m.src, "--tmp-overlay", m.dest);
  }

  // Shadow agent dir: settingsPath provided → filtered settings active
  const shadowArgs = settingsPath ? shadowAgentMountArgs(agentDirReal, settingsPath) : [];
  const agentDirEnv = settingsPath ? [
    "--setenv", "PI_CODING_AGENT_DIR", "/pit-agent",
  ] : [];

  const args: string[] = [
    "--tmpfs", "/",
    "--dev",   "/dev",
    "--proc",  "/proc",
    ...mountArgs,
    ...shadowArgs,
    "--unshare-user",
    "--unshare-pid",
    "--die-with-parent",
    "--setenv", "HOME", HOME,
    "--setenv", "PATH", `${nodeDir}/bin:/usr/local/bin:/usr/bin:/bin`,
    "--setenv", "PI_CODING_AGENT", "true",
    ...agentDirEnv,
    "--chdir", cwd,
    "--",
    nodeBin, piScript, ...piArgs,
  ];

  const result = spawnSync(bwrap, args, { stdio: "inherit" });
  if (settingsPath) try { fs.unlinkSync(settingsPath); } catch { /* already gone */ }
  process.exit(result.status ?? 1);
}

/**
 * Launch pi — sandboxed via bwrap if available and requested, direct otherwise.
 * settingsPath is only used in sandboxed mode (shadow agent dir).
 */
async function launch(
  cwd: string,
  piArgs: string[],
  sandbox: boolean,
  settingsPath?: string,
): Promise<void> {
  if (sandbox) {
    const bwrap = findBwrap();
    if (bwrap) {
      bwrapLaunch(cwd, piArgs, settingsPath); // never returns
    }
    console.warn("pit: bwrap not found — running without sandbox");
  }
  // No sandbox: use real pi settings unchanged
  process.chdir(cwd);
  await main(piArgs);
}

// ── dispatch ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

void (async () => {
  // ── strip pit-only flags (--no-sandbox, -nt / --no-tree) ─────────────────
  const { sandbox, noTree, filteredArgv } = parseFlags(argv);

  // ── pi subcommands: forward directly ────────────────────────────────────
  if (filteredArgv.length > 0 && PI_SUBCOMMANDS.has(filteredArgv[0])) {
    const r = spawnSync("pi", filteredArgv, { stdio: "inherit", shell: false });
    process.exit(r.status ?? 0);
  }

  // ── info-only flags: skip worktree, pass straight to pi ─────────────────
  if (filteredArgv.some((f) => INFO_ONLY_FLAGS.has(f))) {
    await main(filteredArgv);
    return;
  }

  // ── pit -r [id]: worktree-aware resume picker ────────────────────────────
  if (filteredArgv[0] === "-r" || filteredArgv[0] === "--resume") {
    const piArgs = filteredArgv.slice(1);
    const picked = await showPicker(piArgs, sandbox);
    if (!picked) return;

    const result = worktreeCheck(picked.meta);
    const sandboxMounts = resolveSandboxMounts(result.cwd, sandbox);

    const settingsPath = makeTempSettingsFile();
    const escapeSocket = await startPitEscape(
      result.cwd,
      result.meta.id,
      settingsPath,
    );
    if (escapeSocket) process.env.PIT_ESCAPE_SOCKET = escapeSocket;
    await launch(
      result.cwd,
      ["--session", picked.sessionFile, ...extensionArgs(), ...systemPromptArgs(result.meta, sandboxMounts), ...piArgs],
      sandbox,
      settingsPath,
    );
    try { fs.unlinkSync(settingsPath); } catch { /* already gone */ }
    return;
  }

  // ── new session (or user-managed session) ────────────────────────────────
  const userManagingSession = filteredArgv.some((f) => SESSION_FLAGS.has(f));

  // Pre-check: never create a nested worktree when already inside a linked git worktree.
  // This catches any linked worktree, not just pit ones — nesting is never useful.
  if (!noTree && isLinkedWorktree(process.cwd())) {
    const cwd = process.cwd();
    if (userManagingSession) {
      // User controls session directly — launch in place, no pit session management.
      await launch(cwd, filteredArgv, sandbox);
      return;
    }
    const sandboxMounts = resolveSandboxMounts(cwd, sandbox);
    const session = await findOrCreateLinkedSession(cwd, AGENT_DIR, sandboxMounts);
    if (session.kind === "new") {
      console.error("pit: already in a git worktree — no pit session found, running no-tree");
    }
    const sessionSettingsPath = makeTempSettingsFile();
    const escapeSocket = await startPitEscape(
      cwd,
      session.meta.id,
      sessionSettingsPath,
    );
    if (escapeSocket) process.env.PIT_ESCAPE_SOCKET = escapeSocket;
    await launch(
      cwd,
      ["--session", session.sessionFile, ...extensionArgs(), ...systemPromptArgs(session.meta, sandboxMounts), ...filteredArgv],
      sandbox,
      sessionSettingsPath,
    );
    try { fs.unlinkSync(sessionSettingsPath); } catch { /* already gone */ }
    return;
  }

  const result = worktreeCheck(undefined, noTree);

  // Initialise filtered settings and pit-escape for every session (both new
  // and user-managed), so /reload works and the git tool is always available.
  const settingsPath = makeTempSettingsFile();
  const escapeSocket = await startPitEscape(
    result.cwd,
    result.meta.id,
    settingsPath,
  );
  if (escapeSocket) process.env.PIT_ESCAPE_SOCKET = escapeSocket;

  let piArgs: string[];
  if (userManagingSession) {
    // User controls session — just establish the worktree and pass through
    piArgs = filteredArgv;
  } else {
    // pit seeds the session file with the TUI banner (once, on creation).
    // Context reaches the model via --append-system-prompt on every launch.
    const sandboxMounts = resolveSandboxMounts(result.cwd, sandbox);
    const sessionFile = setupNewSession(result, AGENT_DIR, sandboxMounts);
    piArgs = ["--session", sessionFile, ...extensionArgs(), ...systemPromptArgs(result.meta, sandboxMounts), ...filteredArgv];
  }

  await launch(result.cwd, piArgs, sandbox, settingsPath);
  try { fs.unlinkSync(settingsPath); } catch { /* already gone */ }
})().catch((err: unknown) => {
  console.error(`pit: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
