/**
 * Pure session logic — builds session file content and system prompt args.
 * No filesystem, no process spawning.
 */

import { randomBytes } from "node:crypto";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import type { PitMetadata, WorktreeResult, SandboxMounts } from "../../types.ts";
import { formatSandboxNote } from "../sandbox/pure.ts";

// ── bucket naming ─────────────────────────────────────────────────────────────

/**
 * Derive the session bucket directory name for a cwd path.
 * Matches pi's internal naming: strip leading slash, replace separators
 * with dashes, wrap with "--".
 */
export const cwdToBucket = (cwd: string): string => {
  return "--" + cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
};

// ── session content ───────────────────────────────────────────────────────────

/**
 * Build the JSONL content for a new session file.
 * Produces two or three lines: session header, pit CustomEntry, and optionally
 * a CustomMessageEntry (TUI banner) when running in sandbox mode.
 * Callers supply sessionId and isoTs so new Date() stays at the IO boundary.
 */
export const buildSessionLines = (
  result: Readonly<WorktreeResult>,
  sessionId: string,
  isoTs: string,
  sandboxMounts?: SandboxMounts,
): string => {
  const id1 = randomBytes(4).toString("hex");
  const { meta } = result;
  const id2 = sandboxMounts ? randomBytes(4).toString("hex") : null;
  const lines = [
    { type: "session", version: CURRENT_SESSION_VERSION, id: sessionId, timestamp: isoTs, cwd: result.cwd },
    { type: "custom", id: id1, parentId: null, timestamp: isoTs, customType: "pit", data: meta },
    ...(sandboxMounts && id2 ? [{
      type: "custom_message", id: id2, parentId: id1, timestamp: isoTs,
      customType: "pit", content: formatSandboxNote(sandboxMounts), display: true,
    }] : []),
  ];
  return lines.map((o) => JSON.stringify(o)).join("\n") + "\n";
};

// ── pi args helper ────────────────────────────────────────────────────────────

/**
 * Build the --append-system-prompt args to pass to pi on every launch.
 * Only passes sandbox context — agent derives git context from git tools.
 * Returns empty array when not sandboxed (no pit context needed).
 */
export const systemPromptArgs = (sandboxMounts: Readonly<SandboxMounts> | undefined): string[] => {
  if (!sandboxMounts) return [];
  return ["--append-system-prompt", formatSandboxNote(sandboxMounts)];
};
