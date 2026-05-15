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
import * as crypto from "node:crypto";
import { execSync, execFileSync, spawnSync } from "node:child_process";
import {
  main,
  SessionManager,
  SessionSelectorComponent,
  initTheme,
  getAgentDir,
  type CustomEntry,
} from "@earendil-works/pi-coding-agent";
import {
  type PitMetadata,
  type WorktreeResult,
  type SandboxMounts,
  cwdToBucket as _cwdToBucket,
  parseFlags,
  buildAnnouncement,
  setupNewSession as _setupNewSession,
} from "./utils.ts";

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

// ── helpers ───────────────────────────────────────────────────────────────────

function genId(): string {
  return crypto.randomBytes(4).toString("hex");
}

// ── git ───────────────────────────────────────────────────────────────────────

function gitRepoRoot(): string | null {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function branchExists(repo: string, branch: string): boolean {
  try {
    execFileSync(
      "git",
      ["-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { stdio: "ignore" }
    );
    return true;
  } catch {
    return false;
  }
}

// ── worktree check ────────────────────────────────────────────────────────────

/**
 * Determine launch mode and cwd.
 *
 * - Resume (existingMeta provided): verify/recreate the existing worktree.
 * - New session: check for git, create a worktree if possible, else no-tree.
 *   Pass forceNoTree=true to skip worktree creation even inside a git repo.
 *
 * Always returns a fully populated WorktreeResult.
 */
function worktreeCheck(existingMeta?: PitMetadata, forceNoTree = false): WorktreeResult {
  // ── resume path ────────────────────────────────────────────────────────────
  if (existingMeta) {
    if (existingMeta.mode === "no-tree") {
      return { mode: "no-tree", cwd: existingMeta.worktree, meta: existingMeta };
    }

    if (fs.existsSync(existingMeta.worktree)) {
      return { mode: "worktree", cwd: existingMeta.worktree, meta: existingMeta };
    }

    // Worktree directory missing — try to recreate
    console.log("pit: worktree missing, attempting to recreate…");
    if (!branchExists(existingMeta.repo, existingMeta.branch)) {
      console.error(
        `pit: branch '${existingMeta.branch}' no longer exists — cannot recreate worktree`
      );
      process.exit(1);
    }
    try {
      execSync("git worktree prune", { cwd: existingMeta.repo, stdio: "ignore" });
      execFileSync(
        "git",
        [
          "-C",
          existingMeta.repo,
          "worktree",
          "add",
          existingMeta.worktree,
          existingMeta.branch,
        ],
        { stdio: "inherit" }
      );
    } catch (e: unknown) {
      console.error(
        `pit: failed to recreate worktree: ${e instanceof Error ? e.message : String(e)}`
      );
      process.exit(1);
    }
    console.log(`pit: worktree recreated at ${existingMeta.worktree}`);
    return { mode: "worktree", cwd: existingMeta.worktree, meta: existingMeta };
  }

  // ── new session path ───────────────────────────────────────────────────────
  const repo = gitRepoRoot();

  if (!repo) {
    const cwd = process.cwd();
    const meta: PitMetadata = {
      id: genId(),
      repo: cwd,
      worktree: cwd,
      branch: "",
      created: new Date().toISOString(),
      mode: "no-tree",
      noTreeReason: "no-repo",
    };
    return { mode: "no-tree", cwd, meta };
  }

  if (forceNoTree) {
    // Inside a git repo but the user explicitly requested no worktree.
    // Use cwd as-is (no branch, no worktree directory).
    const cwd = process.cwd();
    const meta: PitMetadata = {
      id: genId(),
      repo: repo,
      worktree: cwd,
      branch: "",
      created: new Date().toISOString(),
      mode: "no-tree",
      noTreeReason: "forced",
    };
    return { mode: "no-tree", cwd, meta };
  }

  const id = genId();
  const branch = `pi/${id}`;
  const worktree = path.join(
    path.dirname(repo),
    `${path.basename(repo)}-wt-${id}`
  );
  const meta: PitMetadata = {
    id,
    repo,
    worktree,
    branch,
    created: new Date().toISOString(),
    mode: "worktree",
  };

  console.log("pit: creating worktree");
  console.log(`  branch:   ${branch}`);
  console.log(`  worktree: ${worktree}`);
  execFileSync("git", ["worktree", "add", "-b", branch, worktree, "HEAD"], {
    stdio: "inherit",
  });

  return { mode: "worktree", cwd: worktree, meta };
}

// ── session pre-seeding ───────────────────────────────────────────────────────

/**
 * Resolve sandbox mounts for a new session announcement.
 * Returns the mount list when bwrap is active, undefined otherwise.
 * Passing undefined to setupNewSession suppresses the sandbox section entirely.
 */
function resolveSandboxMounts(cwd: string, useSandbox: boolean): SandboxMounts | undefined {
  if (!useSandbox) return undefined;
  if (!findBwrap()) return undefined;
  const nodeDir = path.dirname(path.dirname(process.execPath));
  return buildSandboxMounts(cwd, fs.realpathSync(AGENT_DIR), getExtensionMounts(), nodeDir);
}

function setupNewSession(result: WorktreeResult, sandboxMounts: SandboxMounts | undefined): string {
  return _setupNewSession(result, AGENT_DIR, sandboxMounts);
}

/**
 * Build the --append-system-prompt args to pass to pi on every launch.
 * Gives the model current pit mode and sandbox state without touching the
 * session file tree.
 */
function systemPromptArgs(meta: PitMetadata, sandboxMounts: SandboxMounts | undefined): string[] {
  return ["--append-system-prompt", buildAnnouncement(meta, sandboxMounts)];
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
      (progress) => SessionManager.list(process.cwd(), undefined, progress),
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
  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8")) as {
    extensions?: string[];
  };
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
 * Build the canonical mount list for the bwrap sandbox.
 *
 * Pure function — all environmental reads (agentDirReal, extensionMounts) are
 * resolved by the caller and injected. This is the single source of truth for
 * both the bwrap argument list (bwrapLaunch) and the session announcement
 * (formatSandboxNote). Add or remove entries here and both stay in sync.
 *
 * agentDirReal must be the symlink-resolved path: --ro-bind HOME HOME copies
 * the symlink into the new root, so mounting the real target here is what makes
 * the rw --bind override the ro home mount correctly.
 */
function buildSandboxMounts(cwd: string, agentDirReal: string, extensionMounts: string[], nodeDir: string): SandboxMounts {
  return {
    // bwrapLaunch emits ro first, then rw — later mounts win for overlapping
    // paths, so rw binds always override the ro home base mount.
    ro: [
      // home (ro base — covers mise installs, ~/.cache/ms-playwright, etc.)
      { path: HOME, label: "home directory" },
      // system dirs
      { path: "/usr",     label: "system dirs" },
      { path: "/etc",     label: "system dirs" },
      // /etc/resolv.conf → /mnt/wsl/resolv.conf on WSL; without this mount
      // the symlink dangles inside the sandbox and DNS fails with EAI_AGAIN.
      { path: "/mnt/wsl", label: "system dirs", optional: true },
      { path: "/lib",     label: "system dirs", optional: true },
      { path: "/lib64",   label: "system dirs", optional: true },
      { path: "/bin",     label: "system dirs", optional: true },
      { path: "/sbin",    label: "system dirs", optional: true },
      // Pi extensions and their node_modules
      ...extensionMounts.map((p) => ({ path: p, label: "Pi extensions" })),
    ],
    rw: [
      // rw subdirectory overrides — all applied after the ro home base,
      // so they win for their specific paths.
      { path: cwd },
      { path: agentDirReal,                               label: "Pi config dir" },
      // npm cache + global node_modules (needed for `pi install` inside a session)
      { path: path.join(HOME, ".npm"),                    label: "npm cache" },
      { path: path.join(HOME, ".local/share/mise/shims"), label: "mise shims" },
      { path: path.join(nodeDir, "lib/node_modules"),     label: "Node.js global modules" },
      { path: path.join(nodeDir, "bin"),                  label: "Node.js bin" },
    ],
  };
}

/**
 * Spawn the sandboxed pi session via bwrap.
 * The outer process handles all worktree/session setup; bwrap only wraps
 * the actual pi session. Never returns — exits the process.
 */
function bwrapLaunch(cwd: string, piArgs: string[]): never {
  const bwrap = findBwrap()!; // caller checks first
  const nodeBin = process.execPath;
  const nodeDir = path.dirname(path.dirname(nodeBin));
  const piScript = fs.realpathSync(
    execSync("which pi", { encoding: "utf8" }).trim()
  );

  const mounts = buildSandboxMounts(cwd, fs.realpathSync(AGENT_DIR), getExtensionMounts(), nodeDir);
  const mountArgs: string[] = [];
  for (const m of mounts.ro) {
    mountArgs.push(m.optional ? "--ro-bind-try" : "--ro-bind", m.path, m.path);
  }
  for (const m of mounts.rw) {
    mountArgs.push("--bind", m.path, m.path);
  }

  const args: string[] = [
    "--tmpfs", "/",
    "--dev",   "/dev",
    "--proc",  "/proc",
    ...mountArgs,
    "--unshare-user",
    "--unshare-pid",
    "--die-with-parent",
    "--setenv", "HOME", HOME,
    "--setenv", "PATH", `${nodeDir}/bin:/usr/local/bin:/usr/bin:/bin`,
    "--setenv", "PI_CODING_AGENT", "true",
    "--chdir", cwd,
    "--",
    nodeBin, piScript, ...piArgs,
  ];

  const result = spawnSync(bwrap, args, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

/**
 * Launch pi — sandboxed via bwrap if available and requested, direct otherwise.
 */
async function launch(
  cwd: string,
  piArgs: string[],
  sandbox: boolean
): Promise<void> {
  if (sandbox) {
    const bwrap = findBwrap();
    if (bwrap) {
      bwrapLaunch(cwd, piArgs); // never returns
    }
    console.warn("pit: bwrap not found — running without sandbox");
  }
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
    await launch(result.cwd, ["--session", picked.sessionFile, ...systemPromptArgs(result.meta, sandboxMounts), ...piArgs], sandbox);
    return;
  }

  // ── new session (or user-managed session) ────────────────────────────────
  const userManagingSession = filteredArgv.some((f) => SESSION_FLAGS.has(f));
  const result = worktreeCheck(undefined, noTree);

  let piArgs: string[];
  if (userManagingSession) {
    // User controls session — just establish the worktree and pass through
    piArgs = filteredArgv;
  } else {
    // pit seeds the session file with the TUI banner (once, on creation).
    // Context reaches the model via --append-system-prompt on every launch.
    const sandboxMounts = resolveSandboxMounts(result.cwd, sandbox);
    const sessionFile = setupNewSession(result, sandboxMounts);
    piArgs = ["--session", sessionFile, ...systemPromptArgs(result.meta, sandboxMounts), ...filteredArgv];
  }

  await launch(result.cwd, piArgs, sandbox);
})().catch((err: unknown) => {
  console.error(`pit: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
