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
  getAgentDir,
  CURRENT_SESSION_VERSION,
  type CustomEntry,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

// ── types ─────────────────────────────────────────────────────────────────────

interface PitMetadata {
  id: string;
  /** repo root, or original cwd for no-tree sessions */
  repo: string;
  /** worktree path, or original cwd for no-tree sessions */
  worktree: string;
  /** git branch name; empty string for no-tree sessions */
  branch: string;
  created: string;
  mode: "worktree" | "no-tree";
}

interface WorktreeResult {
  mode: "worktree" | "no-tree";
  cwd: string;
  meta: PitMetadata;
}

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
 * Derive the session bucket directory name for a cwd path.
 * Matches pi's internal naming: strip leading slash, replace separators
 * with dashes, wrap with "--".
 */
function cwdToBucket(cwd: string): string {
  return "--" + cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
}

/**
 * Write a new session JSONL file pre-seeded with pit metadata and a visible
 * mode announcement. Returns the file path to pass as --session to pi.
 *
 * Uses direct file I/O because SessionManager buffers entries in-memory and
 * only flushes them once pi opens the session internally.
 */
function setupNewSession(result: WorktreeResult): string {
  const bucket = cwdToBucket(result.cwd);
  const sessionDir = path.join(AGENT_DIR, "sessions", bucket);
  fs.mkdirSync(sessionDir, { recursive: true });

  const isoTs = new Date().toISOString();
  const fileTs = isoTs.replace(/:/g, "-").replace(".", "-");
  const sessionId = crypto.randomUUID();
  const sessionFile = path.join(sessionDir, `${fileTs}_${sessionId}.jsonl`);

  const id1 = crypto.randomBytes(4).toString("hex");
  const id2 = crypto.randomBytes(4).toString("hex");
  const { meta } = result;

  const announcement =
    meta.mode === "worktree"
      ? `**pit — worktree mode**\nbranch: \`${meta.branch}\`   worktree: \`${meta.worktree}\``
      : `**pit — no-tree mode**\nnot inside a git repository — running in current directory`;

  const lines = [
    { type: "session", version: CURRENT_SESSION_VERSION, id: sessionId, timestamp: isoTs, cwd: result.cwd },
    { type: "custom", id: id1, parentId: null, timestamp: isoTs, customType: "pit", data: meta },
    { type: "custom_message", id: id2, parentId: id1, timestamp: isoTs, customType: "pit", content: announcement, display: true },
  ]
    .map((o) => JSON.stringify(o))
    .join("\n") + "\n";

  fs.writeFileSync(sessionFile, lines, "utf8");
  return sessionFile;
}

// ── resume via pi's native picker ────────────────────────────────────────────────────

/**
 * Run pi's native session picker. If the user picks a pit session, intercept
 * it via session_before_switch (before it renders), cancel the switch, and
 * return the selection so pit can do the worktree check and relaunch.
 * Non-pit sessions open normally inside this call and null is returned.
 */
async function runPickerIntercept(
  piArgs: string[]
): Promise<{ sessionFile: string; meta: PitMetadata } | null> {
  let intercepted: { sessionFile: string; meta: PitMetadata } | null = null;

  const factory: ExtensionFactory = (pi) => {
    pi.on("session_before_switch", (ctx, event) => {
      if (event.reason !== "resume" || !event.targetSessionFile) return {};
      try {
        const sm = SessionManager.open(event.targetSessionFile);
        const pitEntry = sm.getEntries().find(
          (e): e is CustomEntry<PitMetadata> =>
            e.type === "custom" && (e as CustomEntry).customType === "pit"
        );
        if (!pitEntry?.data) return {}; // not a pit session — open normally
        intercepted = { sessionFile: event.targetSessionFile, meta: pitEntry.data };
        ctx.shutdown();
        return { cancel: true };
      } catch {
        return {};
      }
    });
  };

  await main(["--resume", ...piArgs], { extensionFactories: [factory] });
  return intercepted;
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

  const args: string[] = [
    "--tmpfs", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/etc", "/etc",
    // /etc/resolv.conf is a symlink to /mnt/wsl/resolv.conf on WSL
    "--ro-bind-try", "/mnt/wsl", "/mnt/wsl",
    "--ro-bind-try", "/lib", "/lib",
    "--ro-bind-try", "/lib64", "/lib64",
    "--ro-bind-try", "/bin", "/bin",
    "--ro-bind-try", "/sbin", "/sbin",
    // node runtime (includes pi + global node_modules)
    "--ro-bind", nodeDir, nodeDir,
    // pi config dir (read-write — auth token refresh and settings need write access)
    "--bind", AGENT_DIR, AGENT_DIR,
    // worktree (rw — the whole point)
    "--bind", cwd, cwd,
  ];

  for (const mount of getExtensionMounts()) {
    args.push("--ro-bind", mount, mount);
  }

  args.push(
    "--unshare-user",
    "--unshare-pid",
    "--die-with-parent",
    "--setenv", "HOME", HOME,
    "--setenv", "PATH", `${nodeDir}/bin:/usr/local/bin:/usr/bin:/bin`,
    "--setenv", "PI_CODING_AGENT", "true",
    "--chdir", cwd,
    "--",
    nodeBin, piScript, ...piArgs
  );

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
  let sandbox = true;
  let noTree = false;
  const filteredArgv: string[] = [];
  for (const arg of argv) {
    if (arg === "--no-sandbox") sandbox = false;
    else if (arg === "-nt" || arg === "--no-tree") noTree = true;
    else filteredArgv.push(arg);
  }

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
    // Pi's picker runs in the outer process (no bwrap yet).
    // runPickerIntercept intercepts pit sessions before they render,
    // returning the selection so we can do worktree check + relaunch.
    // Non-pit sessions open normally inside this call.
    const picked = await runPickerIntercept(piArgs);
    if (!picked) return; // user cancelled or opened a non-pit session normally

    const result = worktreeCheck(picked.meta);
    await launch(result.cwd, ["--session", picked.sessionFile, ...piArgs], sandbox);
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
    // pit seeds the session file with metadata and mode announcement
    const sessionFile = setupNewSession(result);
    piArgs = ["--session", sessionFile, ...filteredArgv];
  }

  await launch(result.cwd, piArgs, sandbox);
})().catch((err: unknown) => {
  console.error(`pit: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
