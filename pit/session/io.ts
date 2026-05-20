/**
 * Session IO — reads and writes pi session JSONL files.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { SessionManager, type CustomEntry } from "@earendil-works/pi-coding-agent";
import type { PitMetadata, WorktreeResult, SandboxMounts, LinkedWorktreeSession } from "../types.ts";
import { cwdToBucket, buildSessionLines } from "./pure.ts";
import { genId, buildNoTreeMeta } from "../worktree/pure.ts";

// ── session discovery ─────────────────────────────────────────────────────────

/**
 * Scan the sessions directory for this cwd and return the most recent pit session.
 * Returns null if no pit session exists.
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

// ── session creation ──────────────────────────────────────────────────────────

/**
 * Write a new session JSONL file pre-seeded with pit metadata and a visible
 * mode announcement. Returns the file path to pass as --session to pi.
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

  fs.writeFileSync(sessionFile, buildSessionLines(result, sessionId, isoTs, sandboxMounts), "utf8");
  return sessionFile;
}

// ── linked-worktree session ───────────────────────────────────────────────────

/**
 * Find the existing pit session for cwd, or create a fresh no-tree session.
 * Pure worktree/session concern — sandbox settings are handled by the caller (pit.ts).
 */
export async function findOrCreateLinkedSession(
  cwd: string,
  agentDir: string,
  sandboxMounts?: SandboxMounts,
): Promise<LinkedWorktreeSession> {
  const existing = await findPitSession(cwd, agentDir);
  if (existing) {
    return { kind: "resume", sessionFile: existing.sessionFile, meta: existing.meta };
  }
  const id = genId();
  const meta = buildNoTreeMeta(cwd, cwd, "linked-worktree", id, new Date().toISOString());
  const sessionFile = setupNewSession({ mode: "no-tree", cwd, meta }, agentDir, sandboxMounts);
  return { kind: "new", sessionFile, meta };
}
