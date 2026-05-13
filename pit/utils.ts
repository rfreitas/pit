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
}

export interface WorktreeResult {
  mode: "worktree" | "no-tree";
  cwd: string;
  meta: PitMetadata;
}

// ── bucket naming ─────────────────────────────────────────────────────────────

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
 * Accepts agentDir as a parameter for testability (tests pass a temp dir).
 */
export function setupNewSession(result: WorktreeResult, agentDir: string): string {
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
