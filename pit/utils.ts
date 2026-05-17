/**
 * Pure utility functions extracted from pit.ts for testability.
 * pit.ts imports from here; tests import directly.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { CURRENT_SESSION_VERSION, SessionManager, type CustomEntry } from "@earendil-works/pi-coding-agent";

// ── types ─────────────────────────────────────────────────────────────────────

export interface PitMetadata {
  id: string;
  /** repo root, or original cwd for no-tree sessions */
  repo: string;
  /** worktree path, or original cwd for no-tree sessions */
  worktree: string;
  /** git branch name; empty string for no-tree sessions */
  branch: string;
  created: string;
  mode: "worktree" | "no-tree";
  /** why no-tree: absent git repo, user explicitly passed -nt/--no-tree, or cwd is already a linked worktree */
  noTreeReason?: "no-repo" | "forced" | "linked-worktree";
}

export interface WorktreeResult {
  mode: "worktree" | "no-tree";
  cwd: string;
  meta: PitMetadata;
}

// ── sandbox ──────────────────────────────────────────────────────────────────

/**
 * A single bwrap mount entry. Drives both the bwrap arg list in pit.ts
 * and the sandbox section of the session announcement, so the two stay
 * in sync automatically.
 */
export interface RoMount {
  path: string;
  label?: string;
  /** Use --ro-bind-try instead of --ro-bind (silently skipped if missing). */
  optional?: boolean;
}

export interface RwMount {
  path: string;
  label?: string;
}

export interface OverlayMount {
  /** Lower (read-only) directory — the parent repo's unversioned dir. */
  src: string;
  /** Mount point inside the sandbox — the worktree's corresponding path. */
  dest: string;
  /** Display label shown in the sandbox announcement (e.g. the relative path). */
  label?: string;
}

export interface SandboxMounts {
  ro: RoMount[];
  rw: RwMount[];
  /**
   * Ephemeral overlay mounts: the parent repo's unversioned dirs are overlaid
   * onto the worktree using a tmpfs upper layer. Reads come from the parent;
   * writes succeed but vanish when the session ends.
   */
  overlay?: OverlayMount[];
}

/**
 * Build the sandbox section of the session announcement from the mount lists.
 * Entries are grouped by label (or path when no label), preserving order
 * and deduplicating repeated labels (e.g. several extension paths → one entry).
 */
export function formatSandboxNote(mounts: SandboxMounts): string {
  const dedup = (items: Array<{ path: string; label?: string }>) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of items) {
      const key = m.label ?? m.path;
      if (!seen.has(key)) { seen.add(key); out.push(`\`${key}\``); }
    }
    return out.join(", ");
  };
  const overlays = mounts.overlay ?? [];
  const overlayLine = overlays.length > 0
    ? `\n- Ephemeral overlay (reads from parent, writes vanish on exit): ${dedup(overlays.map((m) => ({ path: m.dest, label: m.label })))}`
    : "";
  return `**Sandbox (bwrap):** This session runs inside an OS-level namespace (bubblewrap). Filesystem access is allowlist-based:
- Read-write: ${dedup(mounts.rw)}
- Read-only: ${dedup(mounts.ro)}${overlayLine}
- No access: anything outside the mounts listed above`;
}

/**
 * Build the mode announcement shown to the agent at session start.
 * Pure function — output depends only on the worktree result and sandbox mounts.
 */
export function buildAnnouncement(meta: PitMetadata, sandboxMounts?: SandboxMounts): string {
  const sandboxSection = sandboxMounts ? `\n\n${formatSandboxNote(sandboxMounts)}` : "";
  if (meta.mode === "worktree") {
    return `**pit — worktree mode**
branch: \`${meta.branch}\`   worktree: \`${meta.worktree}\`

**Worktree:** You are working in an isolated git worktree on branch \`${meta.branch}\`, not on the main branch. Your changes stay here until the user reviews and merges them. The main working tree is untouched.${sandboxSection}`;
  }
  if (meta.noTreeReason === "linked-worktree") {
    return `**pit — no-tree mode** *(already inside a git worktree)*
Running directly in this git worktree — no new worktree was created.

No additional git isolation. Changes affect this worktree directly.${sandboxSection}`;
  }
  if (meta.noTreeReason === "forced") {
    return `**pit — no-tree mode** *(worktree creation skipped)*
Running in current directory — git worktree creation was skipped (\`-nt\`/\`--no-tree\`).

No git isolation. Changes affect the current directory directly.${sandboxSection}`;
  }
  return `**pit — no-tree mode**
Not inside a git repository — running in current directory without a worktree.

No git isolation. Changes affect the current directory directly.${sandboxSection}`;
}



/**
 * Return the relative paths of all unversioned directories in a git repo root.
 *
 * Runs two git commands:
 *   1. `git ls-files --others --directory --exclude-standard`          → untracked dirs
 *   2. `git ls-files --others --ignored --directory --exclude-standard` → ignored dirs
 *
 * The `--directory` flag makes git report an unversioned directory as a unit
 * (e.g. `node_modules/`) instead of recursing into it, and it automatically
 * recurses into *tracked* directories to find nested unversioned ones
 * (e.g. `packages/foo/node_modules/`). Results have trailing slashes stripped.
 *
 * Returns [] if git is unavailable or the path is not a git repo.
 */
export function resolveUnversionedDirs(parentRepo: string): string[] {
  const run = (extra: string[]) => {
    try {
      return execFileSync(
        "git",
        ["-C", parentRepo, "ls-files", "--others", "--directory", "--exclude-standard", ...extra],
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
      ).trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };

  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of [...run([]), ...run(["--ignored"])]) {
    // git uses a trailing slash to mark directories when --directory is set;
    // entries without a trailing slash are individual unversioned files — skip them.
    if (!raw.endsWith("/")) continue;
    const rel = raw.replace(/\/$/, "");
    if (rel && !seen.has(rel)) {
      seen.add(rel);
      result.push(rel);
    }
  }
  return result;
}

/**
 * Return the parent repo root for a linked worktree, or null if cwd is a main
 * checkout, a submodule, or not a git directory.
 *
 * A linked worktree's .git file contains "gitdir: <mainGitDir>/worktrees/<name>".
 * The parent repo root is path.dirname(mainGitDir).
 *
 * Returns null for:
 *   - non-git directories (no .git)
 *   - main worktrees (.git is a directory)
 *   - submodules (.git file whose gitdir contains /modules/ not /worktrees/)
 */
export function resolveParentRepo(cwd: string): string | null {
  try {
    const gitPath = path.join(cwd, ".git");
    if (fs.statSync(gitPath).isDirectory()) return null; // main worktree
    const worktreeDir = fs.readFileSync(gitPath, "utf8").trim().replace(/^gitdir:\s*/, "");
    if (!worktreeDir.includes("/.git/worktrees/")) return null; // submodule
    const mainGitDir = path.resolve(worktreeDir, "../..");
    return path.dirname(mainGitDir);
  } catch {
    return null;
  }
}

// ── worktree detection ───────────────────────────────────────────────────────

/**
 * Returns true if cwd is a git linked worktree (not a main checkout or submodule).
 *
 * Git invariant: a linked worktree always has .git as a plain file whose content
 * is "gitdir: <path>/.git/worktrees/<name>". The main checkout has .git as a
 * directory; submodules have .git as a file but their gitdir contains /modules/
 * instead of /worktrees/. This check requires no branch name knowledge.
 */
export function isLinkedWorktree(cwd: string): boolean {
  try {
    const gitPath = path.join(cwd, ".git");
    if (fs.statSync(gitPath).isDirectory()) return false;
    const gitdir = fs.readFileSync(gitPath, "utf8").trim().replace(/^gitdir:\s*/, "");
    return gitdir.includes("/.git/worktrees/");
  } catch {
    return false;
  }
}

/**
 * Read the current branch name for a linked worktree.
 * Returns null if the directory is not a linked worktree, is detached HEAD,
 * or no longer exists (e.g. the worktree was deleted after the session was created).
 */
export function readWorktreeBranch(cwd: string): string | null {
  try {
    const gitPath = path.join(cwd, ".git");
    if (fs.statSync(gitPath).isDirectory()) return null;
    const gitdir = fs.readFileSync(gitPath, "utf8").trim().replace(/^gitdir:\s*/, "");
    if (!gitdir.includes("/.git/worktrees/")) return null;
    const head = fs.readFileSync(path.join(gitdir, "HEAD"), "utf8").trim();
    const m = head.match(/^ref: refs\/heads\/(.+)$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Scan the sessions directory for this cwd and return the most recent pit session.
 * Returns null if no pit session exists (e.g. the user's own worktree, or it was deleted).
 *
 * Accepts agentDir as a parameter so tests can pass a temp directory.
 */
export async function findPitSession(
  cwd: string,
  agentDir: string
): Promise<{ sessionFile: string; meta: PitMetadata } | null> {
  const sessionDir = path.join(agentDir, "sessions", cwdToBucket(cwd));
  let sessions: Awaited<ReturnType<typeof SessionManager.list>>;
  try {
    sessions = await SessionManager.list(cwd, sessionDir);
  } catch {
    return null;
  }
  // Most recent first
  sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  for (const session of sessions) {
    try {
      const sm = SessionManager.open(session.path);
      const entry = sm.getEntries().find(
        (e): e is CustomEntry<PitMetadata> =>
          e.type === "custom" && (e as CustomEntry).customType === "pit"
      );
      if (entry?.data) return { sessionFile: session.path, meta: entry.data };
    } catch { /* skip corrupt or unreadable sessions */ }
  }
  return null;
}

/**
 * List all linked worktrees for a git repository (excludes the main checkout).
 * Used by pit -r to include worktree sessions in the picker's current-tab.
 *
 * Returns an empty array for non-git dirs or if git is unavailable.
 */
export function listRepoWorktrees(repo: string): string[] {
  try {
    const out = execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const paths: string[] = [];
    let currentPath = "";
    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) {
        currentPath = line.slice(9).trim();
      } else if (line === "" && currentPath) {
        if (currentPath !== repo) paths.push(currentPath);
        currentPath = "";
      }
    }
    return paths;
  } catch {
    return [];
  }
}

/**
 * Derive the session bucket directory name for a cwd path.
 * Matches pi's internal naming: strip leading slash, replace separators
 * with dashes, wrap with "--".
 */
export function cwdToBucket(cwd: string): string {
  return "--" + cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
}

// ── pit config ──────────────────────────────────────────────────────────────

/**
 * Pit-specific config, read from <pitDir>/config.json.
 * Absent file = empty config (no filtering).
 */
export interface PitConfig {
  /** Package sources to strip from settings.json when launching sandboxed. */
  denyPackages?: string[];
}

/** Read pit config, returning an empty object if the file doesn't exist. */
export function readPitConfig(pitDir: string): PitConfig {
  const configPath = path.join(pitDir, "config.json");
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8")) as PitConfig;
  } catch {
    return {};
  }
}

/**
 * Filter a settings object by removing denied packages.
 * Pure — returns a new object, never mutates the original.
 */
export function applyDenylist(
  settings: Record<string, unknown>,
  denyPackages: string[]
): Record<string, unknown> {
  if (denyPackages.length === 0) return settings;
  const deny = new Set(denyPackages);
  return {
    ...settings,
    packages: ((settings.packages as string[] | undefined) ?? []).filter(
      (p) => !deny.has(p)
    ),
  };
}

/**
 * Write filtered settings to the host-side path used as the shadow agent dir's
 * settings.json. Creates parent directories as needed.
 */
export function writeFilteredSettings(
  agentDir: string,
  pitConfig: PitConfig,
  hostSettingsPath: string
): void {
  const raw = fs.existsSync(path.join(agentDir, "settings.json"))
    ? fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")
    : "{}";
  const settings = JSON.parse(raw) as Record<string, unknown>;
  const filtered = applyDenylist(settings, pitConfig.denyPackages ?? []);
  fs.mkdirSync(path.dirname(hostSettingsPath), { recursive: true });
  fs.writeFileSync(hostSettingsPath, JSON.stringify(filtered, null, 2) + "\n");
}

// ── flag parsing ───────────────────────────────────────────────────────────────

export interface ParsedFlags {
  sandbox: boolean;
  noTree: boolean;
  filteredArgv: string[];
}

/**
 * Strip pit-only flags from argv, returning the remainder for pi passthrough.
 */
export function parseFlags(argv: string[]): ParsedFlags {
  let sandbox = true;
  let noTree = false;
  const filteredArgv: string[] = [];
  for (const arg of argv) {
    if (arg === "--no-sandbox") sandbox = false;
    else if (arg === "-nt" || arg === "--no-tree") noTree = true;
    else filteredArgv.push(arg);
  }
  return { sandbox, noTree, filteredArgv };
}

// ── session pre-seeding ───────────────────────────────────────────────────────

/**
 * Write a new session JSONL file pre-seeded with pit metadata and a visible
 * mode announcement. Returns the file path to pass as --session to pi.
 *
 * The announcement is written once here (for the TUI banner on first open).
 * On resume, context is delivered via --append-system-prompt instead, so
 * this file is never modified after creation.
 *
 * Accepts agentDir as a parameter for testability (tests pass a temp dir).
 */
export function setupNewSession(result: WorktreeResult, agentDir: string, sandboxMounts?: SandboxMounts): string {
  const bucket = cwdToBucket(result.cwd);
  const sessionDir = path.join(agentDir, "sessions", bucket);
  fs.mkdirSync(sessionDir, { recursive: true });

  const isoTs = new Date().toISOString();
  const fileTs = isoTs.replace(/:/g, "-").replace(".", "-");
  const sessionId = crypto.randomUUID();
  const sessionFile = path.join(sessionDir, `${fileTs}_${sessionId}.jsonl`);

  const id1 = crypto.randomBytes(4).toString("hex");
  const id2 = crypto.randomBytes(4).toString("hex");
  const { meta } = result;

  const lines = [
    { type: "session", version: CURRENT_SESSION_VERSION, id: sessionId, timestamp: isoTs, cwd: result.cwd },
    { type: "custom", id: id1, parentId: null, timestamp: isoTs, customType: "pit", data: meta },
    { type: "custom_message", id: id2, parentId: id1, timestamp: isoTs, customType: "pit", content: buildAnnouncement(meta, sandboxMounts), display: true },
  ]
    .map((o) => JSON.stringify(o))
    .join("\n") + "\n";

  fs.writeFileSync(sessionFile, lines, "utf8");
  return sessionFile;
}

// ── id generation ────────────────────────────────────────────────────────────────────────────────

/** Generate an 8-hex-character random id for worktrees and sessions. */
export function genId(): string {
  return crypto.randomBytes(4).toString("hex");
}

// ── linked-worktree session setup ──────────────────────────────────────────────────

export interface LinkedWorktreeSession {
  /** "resume" = found an existing pit session; "new" = created a fresh no-tree session. */
  kind: "resume" | "new";
  sessionFile: string;
  meta: PitMetadata;
  /**
   * Host-side path to the filtered settings file for bwrap's shadow agent dir.
   * Defined iff useSandbox && hasBwrap — pass to launch() so bwrap can
   * bind-mount it as /pit-agent/settings.json.
   * Undefined when not sandboxed; the caller should skip the shadow mount.
   */
  settingsPath: string | undefined;
}

/**
 * Prepare a session for launching pit inside an already-linked git worktree.
 *
 * Single entry point for the linked-worktree dispatch path in pit.ts.
 * Bundles the three steps that must always happen together:
 *   1. Find or create the session (resume existing vs. fresh no-tree)
 *   2. Compute settingsPath when sandboxed
 *   3. Write the filtered settings so bwrap's shadow dir picks them up
 *
 * The caller handles: starting pit-escape, building piArgs, calling launch().
 * Those involve process spawning and are intentionally kept out of this function.
 */
export async function prepareLinkedWorktreeSession(opts: {
  cwd: string;
  agentDir: string;
  pitDir: string;
  useSandbox: boolean;
  hasBwrap: boolean;
  sandboxMounts?: SandboxMounts;
}): Promise<LinkedWorktreeSession> {
  const { cwd, agentDir, pitDir, useSandbox, hasBwrap, sandboxMounts } = opts;

  const existing = await findPitSession(cwd, agentDir);

  /** Compute the settings path iff sandbox + bwrap are both active. */
  const settingsPathFor = (id: string): string | undefined =>
    useSandbox && hasBwrap ? path.join(pitDir, "sessions", `${id}.json`) : undefined;

  if (existing) {
    const settingsPath = settingsPathFor(existing.meta.id);
    if (settingsPath) writeFilteredSettings(agentDir, readPitConfig(pitDir), settingsPath);
    return { kind: "resume", sessionFile: existing.sessionFile, meta: existing.meta, settingsPath };
  }

  // No existing session — create a fresh no-tree session in place.
  const id = genId();
  const meta: PitMetadata = {
    id,
    repo: cwd,
    worktree: cwd,
    branch: "",
    created: new Date().toISOString(),
    mode: "no-tree",
    noTreeReason: "linked-worktree",
  };
  const sessionFile = setupNewSession({ mode: "no-tree", cwd, meta }, agentDir, sandboxMounts);
  const settingsPath = settingsPathFor(id);
  if (settingsPath) writeFilteredSettings(agentDir, readPitConfig(pitDir), settingsPath);

  return { kind: "new", sessionFile, meta, settingsPath };
}
