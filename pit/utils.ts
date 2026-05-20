/**
 * IO utilities for pit — filesystem reads/writes and process-spawning helpers.
 *
 * Re-exports all types (from ./types.ts), all pure functions (from ./pure.ts),
 * and all git-path utilities (from ./git-utils.ts) so existing importers of
 * this module continue to work unchanged.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { SessionManager, type CustomEntry } from "@earendil-works/pi-coding-agent";

// Re-export everything so callers that import from "./utils.ts" keep working.
export * from "./types.ts";
export * from "./pure.ts";
export { isLinkedWorktree, resolveMainRepo, readWorktreeBranch, listRepoWorktrees } from "./git-utils.ts";

import type { PitMetadata, WorktreeResult, SandboxMounts, PitConfig, LinkedWorktreeSession } from "./types.ts";
import { cwdToBucket, buildSessionLines, buildNoTreeMeta, applyDenylist, genId, buildAnnouncement } from "./pure.ts";

// ── git: unversioned dirs ─────────────────────────────────────────────────────

/**
 * Return the relative paths of all unversioned directories in a git repo root.
 *
 * Runs two git commands:
 *   1. `git ls-files --others --directory --exclude-standard`           → untracked dirs
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

// ── pit config ────────────────────────────────────────────────────────────────

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
 * Write filtered settings to the host-side path used as the shadow agent dir's
 * settings.json. Creates parent directories as needed.
 */
export function writeFilteredSettings(
  agentDir: string,
  pitConfig: PitConfig,
  hostSettingsPath: string,
): void {
  const raw = fs.existsSync(path.join(agentDir, "settings.json"))
    ? fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")
    : "{}";
  const settings = JSON.parse(raw) as Record<string, unknown>;
  const filtered = applyDenylist(settings, pitConfig.denyPackages ?? []);
  fs.mkdirSync(path.dirname(hostSettingsPath), { recursive: true });
  fs.writeFileSync(hostSettingsPath, JSON.stringify(filtered, null, 2) + "\n");
}

// ── session IO ────────────────────────────────────────────────────────────────

/**
 * Scan the sessions directory for this cwd and return the most recent pit session.
 * Returns null if no pit session exists (e.g. the user's own worktree, or it was deleted).
 *
 * Accepts agentDir as a parameter so tests can pass a temp directory.
 */
export async function findPitSession(
  cwd: string,
  agentDir: string,
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

  // IO boundary: generate the non-deterministic inputs here, pass to pure builder.
  const isoTs = new Date().toISOString();
  const fileTs = isoTs.replace(/:/g, "-").replace(".", "-");
  const sessionId = crypto.randomUUID();
  const sessionFile = path.join(sessionDir, `${fileTs}_${sessionId}.jsonl`);

  fs.writeFileSync(sessionFile, buildSessionLines(result, sessionId, isoTs, sandboxMounts), "utf8");
  return sessionFile;
}

// ── linked-worktree session setup ─────────────────────────────────────────────

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
  const meta = buildNoTreeMeta(cwd, cwd, "linked-worktree", id, new Date().toISOString());
  const sessionFile = setupNewSession({ mode: "no-tree", cwd, meta }, agentDir, sandboxMounts);
  const settingsPath = settingsPathFor(id);
  if (settingsPath) writeFilteredSettings(agentDir, readPitConfig(pitDir), settingsPath);

  return { kind: "new", sessionFile, meta, settingsPath };
}
