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
 *   pit -r [id] [pi-flags...]         Pick or directly open an existing pit session
 *   pit install/remove/update/...     Forwarded directly to pi
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as readline from "node:readline";
import { execSync, execFileSync, spawnSync } from "node:child_process";
import {
  main,
  SessionManager,
  getAgentDir,
  type CustomEntry,
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

interface PitSession {
  meta: PitMetadata;
  sessionFile: string;
  name: string;
  modified: Date;
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
 *
 * Always returns a fully populated WorktreeResult.
 */
function worktreeCheck(existingMeta?: PitMetadata): WorktreeResult {
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
 * Create a new session file pre-seeded with pit metadata and a visible mode
 * announcement. Returns the session file path to pass as --session to main().
 */
function setupNewSession(result: WorktreeResult): string {
  const sm = SessionManager.create(result.cwd);
  const { meta } = result;

  // Metadata entry: persists pit info in the session file, not sent to LLM
  sm.appendCustomEntry("pit", meta);

  // Mode announcement: visible in TUI and included in LLM context
  const announcement =
    meta.mode === "worktree"
      ? `**pit — worktree mode**\nbranch: \`${meta.branch}\`   worktree: \`${meta.worktree}\``
      : `**pit — no-tree mode**\nnot inside a git repository — running in current directory`;
  sm.appendCustomMessageEntry("pit", announcement, /* display */ true);

  const file = sm.getSessionFile();
  if (!file) throw new Error("pit: failed to obtain session file path");
  return file;
}

// ── resume picker ─────────────────────────────────────────────────────────────

async function pickPitSession(idArg?: string): Promise<PitSession | null> {
  const allSessions = await SessionManager.listAll();

  const pitSessions: PitSession[] = [];
  for (const info of allSessions) {
    try {
      const sm = SessionManager.open(info.path);
      const entries = sm.getEntries();
      const pitEntry = entries.find(
        (e): e is CustomEntry<PitMetadata> =>
          e.type === "custom" && (e as CustomEntry).customType === "pit"
      );
      if (pitEntry?.data) {
        pitSessions.push({
          meta: pitEntry.data,
          sessionFile: info.path,
          name: info.name ?? (info.firstMessage.slice(0, 60) || "(no name)"),
          modified: info.modified,
        });
      }
    } catch {
      // skip unreadable sessions
    }
  }

  // Most recently modified first
  pitSessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());

  if (pitSessions.length === 0) {
    console.log("pit: no pit sessions found");
    return null;
  }

  if (idArg) {
    const match = pitSessions.find(
      (s) => s.meta.id === idArg || s.meta.id.startsWith(idArg)
    );
    if (!match) {
      console.error(`pit: no session with id '${idArg}'`);
      process.exit(1);
    }
    return match;
  }

  // Interactive numbered list
  console.log("\npit sessions:\n");
  for (let i = 0; i < pitSessions.length; i++) {
    const s = pitSessions[i];
    const status =
      s.meta.mode === "no-tree"
        ? "no-tree"
        : fs.existsSync(s.meta.worktree)
          ? "present"
          : "missing";
    const icon = status === "present" ? "✓" : status === "no-tree" ? "·" : "✗";
    const repo = path.basename(s.meta.repo);
    const branchShort = s.meta.branch ? s.meta.branch.replace("pi/", "") : "—";
    console.log(
      `  ${String(i + 1).padStart(2)}.  ${icon}  [${s.meta.id}]  ` +
        `${s.name.slice(0, 48).padEnd(48)}  ${repo}/${branchShort}`
    );
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await new Promise<string>((resolve) => {
    rl.question(`\nPick [1–${pitSessions.length}]: `, resolve);
  });
  rl.close();

  const n = parseInt(answer.trim(), 10);
  if (isNaN(n) || n < 1 || n > pitSessions.length) {
    console.error("pit: invalid selection");
    process.exit(1);
  }
  return pitSessions[n - 1];
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
  const piAgentDir = fs.existsSync(AGENT_DIR)
    ? fs.realpathSync(AGENT_DIR)
    : AGENT_DIR;

  const args: string[] = [
    "--tmpfs", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/etc", "/etc",
    "--ro-bind-try", "/lib", "/lib",
    "--ro-bind-try", "/lib64", "/lib64",
    "--ro-bind-try", "/bin", "/bin",
    "--ro-bind-try", "/sbin", "/sbin",
    // node runtime (includes pi + global node_modules)
    "--ro-bind", nodeDir, nodeDir,
    // pi config: ro, with sessions rw on top
    "--dir", path.dirname(AGENT_DIR),
    "--ro-bind", piAgentDir, AGENT_DIR,
    "--bind", path.join(piAgentDir, "sessions"), path.join(AGENT_DIR, "sessions"),
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
  // ── strip --no-sandbox (pit-only flag) ───────────────────────────────────
  let sandbox = true;
  const filteredArgv: string[] = [];
  for (const arg of argv) {
    if (arg === "--no-sandbox") sandbox = false;
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
    const rest = filteredArgv.slice(1);
    let idArg: string | undefined;
    let piArgs: string[];
    // treat first arg as id only if it doesn't look like a flag
    if (rest.length > 0 && !rest[0].startsWith("-")) {
      [idArg, ...piArgs] = rest;
    } else {
      piArgs = rest;
    }

    const picked = await pickPitSession(idArg);
    if (!picked) return;

    const result = worktreeCheck(picked.meta);
    await launch(result.cwd, ["--session", picked.sessionFile, ...piArgs], sandbox);
    return;
  }

  // ── new session (or user-managed session) ────────────────────────────────
  const userManagingSession = filteredArgv.some((f) => SESSION_FLAGS.has(f));
  const result = worktreeCheck();

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
