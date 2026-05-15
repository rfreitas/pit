/**
 * Pure utility functions extracted from pit.ts for testability.
 * pit.ts imports from here; tests import directly.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";

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
  /** why no-tree: absent git repo, or user explicitly passed -nt/--no-tree */
  noTreeReason?: "no-repo" | "forced";
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

export interface SandboxMounts {
  ro: RoMount[];
  rw: RwMount[];
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
  return `**Sandbox (bwrap):** This session runs inside an OS-level namespace (bubblewrap). Filesystem access is allowlist-based:
- Read-write: ${dedup(mounts.rw)}
- Read-only: ${dedup(mounts.ro)}
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
 * Derive the session bucket directory name for a cwd path.
 * Matches pi's internal naming: strip leading slash, replace separators
 * with dashes, wrap with "--".
 */
export function cwdToBucket(cwd: string): string {
  return "--" + cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
}

// ── flag parsing ──────────────────────────────────────────────────────────────

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
