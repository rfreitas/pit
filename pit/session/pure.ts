/**
 * Pure session logic — builds session file content and announcement text.
 * No filesystem, no process spawning.
 */

import * as crypto from "node:crypto";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import type { PitMetadata, WorktreeResult, SandboxMounts } from "../types.ts";
import { formatSandboxNote } from "../sandbox/pure.ts";

// ── bucket naming ─────────────────────────────────────────────────────────────

/**
 * Derive the session bucket directory name for a cwd path.
 * Matches pi's internal naming: strip leading slash, replace separators
 * with dashes, wrap with "--".
 */
export function cwdToBucket(cwd: string): string {
  return "--" + cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
}

// ── announcement ──────────────────────────────────────────────────────────────

/**
 * Build the mode announcement shown to the agent at session start.
 * Pure — output depends only on the worktree metadata and sandbox mounts.
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

// ── session content ───────────────────────────────────────────────────────────

/**
 * Build the JSONL content for a new session file.
 * Produces three lines: session header, pit CustomEntry, CustomMessageEntry (TUI banner).
 * Callers supply sessionId and isoTs so new Date() and crypto.randomUUID() stay at the IO boundary.
 */
export function buildSessionLines(
  result: WorktreeResult,
  sessionId: string,
  isoTs: string,
  sandboxMounts?: SandboxMounts,
): string {
  const id1 = crypto.randomBytes(4).toString("hex");
  const id2 = crypto.randomBytes(4).toString("hex");
  const { meta } = result;
  return [
    { type: "session", version: CURRENT_SESSION_VERSION, id: sessionId, timestamp: isoTs, cwd: result.cwd },
    { type: "custom", id: id1, parentId: null, timestamp: isoTs, customType: "pit", data: meta },
    { type: "custom_message", id: id2, parentId: id1, timestamp: isoTs, customType: "pit", content: buildAnnouncement(meta, sandboxMounts), display: true },
  ]
    .map((o) => JSON.stringify(o))
    .join("\n") + "\n";
}

// ── pi args helper ────────────────────────────────────────────────────────────

/**
 * Build the --append-system-prompt args to pass to pi on every launch.
 * Delivers current pit mode and sandbox state without touching the session file.
 */
export function systemPromptArgs(meta: PitMetadata, sandboxMounts: SandboxMounts | undefined): string[] {
  return ["--append-system-prompt", buildAnnouncement(meta, sandboxMounts)];
}
