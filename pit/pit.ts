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
import { execSync, execFileSync, spawnSync, spawn } from "node:child_process";
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
  type OverlayMount,
  resolveUnversionedDirs,
  resolveParentRepo,
  cwdToBucket as _cwdToBucket,
  parseFlags,
  buildAnnouncement,
  setupNewSession as _setupNewSession,
  isLinkedWorktree,
  listRepoWorktrees,
  readWorktreeBranch,
  readPitConfig,
  writeFilteredSettings,
  genId,
  prepareLinkedWorktreeSession,
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

/**
 * Build --extension args for pit's bundled extensions.
 * Only loads from extensions/bundled/ to avoid conflicts with the user's
 * globally-configured extensions (extensions/*.ts).
 */
function extensionArgs(): string[] {
  const scriptDir = path.resolve(path.dirname(process.argv[1]));
  const bundledDir = path.join(scriptDir, "bundled");
  if (!fs.existsSync(bundledDir)) return [];
  return fs.readdirSync(bundledDir)
    .filter((f) => f.endsWith(".ts"))
    .flatMap((f) => ["--extension", path.join(bundledDir, f)]);
}

// ── pit dir ───────────────────────────────────────────────────────────────────

/** ~/.pi/agent/pit — inside the repo-tracked agent config dir */
const PIT_DIR = path.join(AGENT_DIR, "pit");

/** Path to the per-session filtered settings file on the host filesystem. */
function hostSettingsPath(id: string): string {
  return path.join(PIT_DIR, "sessions", `${id}.json`);
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
  try { fs.unlinkSync(socketPath); } catch { /* stale socket from crashed session */ }

  const scriptDir = path.resolve(path.dirname(process.argv[1]));
  const escapeScript = path.join(scriptDir, "pit-escape.ts");

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
        const repo = gitRepoRoot();
        const worktrees = repo ? listRepoWorktrees(repo) : [];

        // Read each worktree's branch once upfront — one fs read per worktree.
        // Falls back to "deleted" when the directory no longer exists.
        const worktreeBranch = new Map(
          worktrees.map((wt) => [wt, readWorktreeBranch(wt) ?? "deleted"])
        );

        const mainPaths = new Set<string>([process.cwd()]);
        if (repo) mainPaths.add(repo);

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
 * Resolve rw git mounts for a linked worktree (where cwd/.git is a file,
 * not a directory). Returns the three paths needed for full git commit access
 * scoped to just this session's branch:
 *   - the worktree metadata dir  (lock files, index, ORIG_HEAD, etc.)
 *   - the shared objects store   (new blobs/trees/commits)
 *   - this session's branch ref  (advance only this branch, not others)
 *
 * Returns [] for main worktrees, non-git dirs, detached HEAD, or any error.
 */
function resolveWorktreeGitRwMounts(cwd: string): Array<{ path: string; label?: string }> {
  try {
    const gitPath = path.join(cwd, ".git");
    if (fs.statSync(gitPath).isDirectory()) return []; // main worktree, not linked
    const worktreeDir = fs.readFileSync(gitPath, "utf8").trim().replace(/^gitdir:\s*/, "");
    const mainGitDir = path.resolve(worktreeDir, "../..");
    const head = fs.readFileSync(path.join(worktreeDir, "HEAD"), "utf8").trim();
    const m = head.match(/^ref: refs\/heads\/(.+)$/);
    if (!m) return []; // detached HEAD
    const branch = m[1];
    // Mount the ref's parent directory so git can create the adjacent .lock file.
    // path.dirname("pi/f3094ac3") === "pi" → only the pit namespace is exposed,
    // not master or any other user branch. Falls back to "refs/heads" for
    // flat branch names (no subdirectory), which is an unlikely case for pit.
    const refDir = path.join(mainGitDir, "refs", "heads", path.dirname(branch));
    return [
      { path: worktreeDir, label: "worktree git metadata" },
      { path: path.join(mainGitDir, "objects"), label: "git objects" },
      { path: refDir, label: "worktree branch ref" },
    ];
  } catch {
    return [];
  }
}

/**
 * Build the canonical mount list for the bwrap sandbox.
 *
 * agentDirReal must be the symlink-resolved path: --ro-bind HOME HOME copies
 * the symlink into the new root, so mounting the real target here is what makes
 * the rw --bind override the ro home mount correctly.
 *
 * bwrapLaunch emits ro first then rw — later mounts win, so rw overrides ro
 * for any overlapping paths (e.g. the rw worktree subdir beats the ro home).
 */
function buildSandboxMounts(cwd: string, agentDirReal: string, extensionMounts: string[], nodeDir: string): SandboxMounts {
  // Overlay mounts: unversioned dirs from the parent repo overlaid onto the
  // worktree with a tmpfs upper layer. Only applies to linked worktrees.
  const overlay: OverlayMount[] = [];
  const parentRepo = resolveParentRepo(cwd);
  if (parentRepo) {
    for (const rel of resolveUnversionedDirs(parentRepo)) {
      const src = path.join(parentRepo, rel);
      const dest = path.join(cwd, rel);
      try {
        if (fs.statSync(src).isDirectory()) {
          overlay.push({ src, dest, label: rel });
        }
      } catch { /* src disappeared between git scan and stat — skip */ }
    }
  }

  return {
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
      // git access scoped to this worktree's branch (no-op for non-worktree sessions)
      ...resolveWorktreeGitRwMounts(cwd),
      // worktree directory and pi config
      { path: cwd },
      { path: agentDirReal,                               label: "Pi config dir" },
      // npm cache + global node_modules (needed for `pi install` inside a session)
      { path: path.join(HOME, ".npm"),                    label: "npm cache" },
      { path: path.join(HOME, ".local/share/mise/shims"), label: "mise shims" },
      { path: path.join(nodeDir, "lib/node_modules"),     label: "Node.js global modules" },
      { path: path.join(nodeDir, "bin"),                  label: "Node.js bin" },
    ],
    overlay,
  };
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

    let settingsPath: string | undefined;
    if (sandbox && findBwrap()) {
      settingsPath = hostSettingsPath(result.meta.id);
      writeFilteredSettings(AGENT_DIR, readPitConfig(PIT_DIR), settingsPath);
    }

    const escapeSocket = await startPitEscape(
      result.cwd,
      result.meta.id,
      settingsPath ?? hostSettingsPath(result.meta.id),
    );
    if (escapeSocket) process.env.PIT_ESCAPE_SOCKET = escapeSocket;
    await launch(
      result.cwd,
      ["--session", picked.sessionFile, ...extensionArgs(), ...systemPromptArgs(result.meta, sandboxMounts), ...piArgs],
      sandbox,
      settingsPath,
    );
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
    const session = await prepareLinkedWorktreeSession({
      cwd,
      agentDir: AGENT_DIR,
      pitDir: PIT_DIR,
      useSandbox: sandbox,
      hasBwrap: !!findBwrap(),
      sandboxMounts,
    });
    if (session.kind === "new") {
      console.log("pit: already in a git worktree — no pit session found, running no-tree");
    }
    const escapeSocket = await startPitEscape(
      cwd,
      session.meta.id,
      session.settingsPath ?? hostSettingsPath(session.meta.id),
    );
    if (escapeSocket) process.env.PIT_ESCAPE_SOCKET = escapeSocket;
    await launch(
      cwd,
      ["--session", session.sessionFile, ...extensionArgs(), ...systemPromptArgs(session.meta, sandboxMounts), ...filteredArgv],
      sandbox,
      session.settingsPath,
    );
    return;
  }

  const result = worktreeCheck(undefined, noTree);

  // Initialise filtered settings and pit-escape for every session (both new
  // and user-managed), so /reload works and the git tool is always available.
  let settingsPath: string | undefined;
  if (sandbox && findBwrap()) {
    settingsPath = hostSettingsPath(result.meta.id);
    writeFilteredSettings(AGENT_DIR, readPitConfig(PIT_DIR), settingsPath);
  }
  const escapeSocket = await startPitEscape(
    result.cwd,
    result.meta.id,
    settingsPath ?? hostSettingsPath(result.meta.id),
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
    const sessionFile = setupNewSession(result, sandboxMounts);
    piArgs = ["--session", sessionFile, ...extensionArgs(), ...systemPromptArgs(result.meta, sandboxMounts), ...filteredArgv];
  }

  await launch(result.cwd, piArgs, sandbox, settingsPath);
})().catch((err: unknown) => {
  console.error(`pit: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
