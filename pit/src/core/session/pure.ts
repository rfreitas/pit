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

// ── JSONL session file parser (DRY extraction helper) ─────────────────────────

export interface ExtractedSessionMeta {
  cwd: string | null;
  name?: string;
  firstMessage: string;
  messageCount: number;
  branch?: string;
}

/**
 * Robustly extracts plaintext from raw message content strings or array-of-blocks.
 */
export const extractTextContent = (content: any): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" && c.type === "text" ? c.text : ""))
      .join("")
      .trim();
  }
  return "";
};

/**
 * Purely parses a session file's raw JSONL text.
 * Filters out sessions belonging to different repositories if `repoFilter` is supplied.
 */
export const parseSessionFileContent = (
  content: string,
  repoFilter?: string,
): ExtractedSessionMeta | null => {
  const lines = content.split("\n").filter((l) => l.trim());

  const parsed = lines.reduce((acc, line) => {
    try {
      const e = JSON.parse(line) as Record<string, any>;
      if (e.type === "session") {
        return { ...acc, cwd: e.cwd ?? null };
      }
      if (e.type === "session_info") {
        return { ...acc, name: e.name?.trim() || undefined };
      }
      if (e.type === "custom" && e.customType === "pit") {
        if (repoFilter && e.data?.repo !== repoFilter) return { ...acc, isRepoMatch: false };
        return { ...acc, branch: e.data?.branch ?? "unknown", hasPitMeta: true };
      }
      if (e.type === "message") {
        const nextMessageCount = acc.messageCount + 1;
        if (!acc.firstMessage && e.message?.role === "user") {
          return { ...acc, messageCount: nextMessageCount, firstMessage: extractTextContent(e.message.content) };
        }
        return { ...acc, messageCount: nextMessageCount };
      }
    } catch { /* skip */ }
    return acc;
  }, { cwd: null as string | null, name: undefined as string | undefined, firstMessage: "", messageCount: 0, branch: "unknown", hasPitMeta: false, isRepoMatch: true });


  if (!parsed.hasPitMeta || !parsed.isRepoMatch) return null;

  return {
    cwd: parsed.cwd,
    name: parsed.name,
    firstMessage: parsed.firstMessage || "(no messages)",
    messageCount: parsed.messageCount,
    branch: parsed.branch,
  };
};
