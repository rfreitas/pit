/**
 * Session IO — reads and writes pi session JSONL files.
 *
 * Internal implementations are Effect-based.
 * Exported functions maintain their original signatures for test compatibility.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { Effect } from "effect";
import { SessionManager, type CustomEntry } from "@earendil-works/pi-coding-agent";
import type {
  PitMetadata,
  WorktreeResult,
  SandboxMounts,
  LinkedWorktreeSession,
} from "../types.ts";
import { cwdToBucket, buildSessionLines } from "./pure.ts";
import { genId, buildNoTreeMeta } from "../worktree/pure.ts";
import { SessionWriteError } from "../errors.ts";

// ── session discovery ─────────────────────────────────────────────────────────

const findPitSessionEffect = (
  cwd: string,
  agentDir: string,
): Effect.Effect<{ sessionFile: string; meta: PitMetadata } | null> =>
  Effect.tryPromise({
    try: async () => {
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
              e.type === "custom" && (e as CustomEntry).customType === "pit",
          );
          if (entry?.data)
            return { sessionFile: session.path, meta: entry.data };
        } catch {
          /* skip corrupt or unreadable sessions */
        }
      }
      return null;
    },
    catch: () => null as never,
  });

/**
 * Scan the sessions directory for this cwd and return the most recent pit session.
 * Returns null if no pit session exists.
 * Accepts agentDir as a parameter so tests can pass a temp directory.
 */
export async function findPitSession(
  cwd: string,
  agentDir: string,
): Promise<{ sessionFile: string; meta: PitMetadata } | null> {
  return Effect.runPromise(findPitSessionEffect(cwd, agentDir));
}

// ── session creation ──────────────────────────────────────────────────────────

const setupNewSessionEffect = (
  result: WorktreeResult,
  agentDir: string,
  sandboxMounts?: SandboxMounts,
): Effect.Effect<string, SessionWriteError> =>
  Effect.try({
    try: () => {
      const bucket = cwdToBucket(result.cwd);
      const sessionDir = path.join(agentDir, "sessions", bucket);
      fs.mkdirSync(sessionDir, { recursive: true });

      const isoTs = new Date().toISOString();
      const fileTs = isoTs.replace(/:/g, "-").replace(".", "-");
      const sessionId = crypto.randomUUID();
      const sessionFile = path.join(sessionDir, `${fileTs}_${sessionId}.jsonl`);

      fs.writeFileSync(
        sessionFile,
        buildSessionLines(result, sessionId, isoTs, sandboxMounts),
        "utf8",
      );
      return sessionFile;
    },
    catch: (e) =>
      new SessionWriteError({
        message: e instanceof Error ? e.message : String(e),
      }),
  });

/**
 * Write a new session JSONL file pre-seeded with pit metadata and a visible
 * mode announcement. Returns the file path to pass as --session to pi.
 * Accepts agentDir as a parameter for testability (tests pass a temp dir).
 */
export function setupNewSession(
  result: WorktreeResult,
  agentDir: string,
  sandboxMounts?: SandboxMounts,
): string {
  return Effect.runSync(setupNewSessionEffect(result, agentDir, sandboxMounts));
}

// ── linked-worktree session ───────────────────────────────────────────────────

export const findOrCreateLinkedSessionEffect = (
  cwd: string,
  agentDir: string,
  sandboxMounts?: SandboxMounts,
): Effect.Effect<LinkedWorktreeSession, SessionWriteError> =>
  Effect.gen(function* () {
    const existing = yield* findPitSessionEffect(cwd, agentDir);
    if (existing) {
      return { kind: "resume" as const, sessionFile: existing.sessionFile, meta: existing.meta };
    }
    const id = genId();
    const meta = buildNoTreeMeta(
      cwd,
      cwd,
      "linked-worktree",
      id,
      new Date().toISOString(),
    );
    const sessionFile = yield* setupNewSessionEffect(
      { mode: "no-tree", cwd, meta },
      agentDir,
      sandboxMounts,
    );
    return { kind: "new" as const, sessionFile, meta };
  });

/**
 * Find the existing pit session for cwd, or create a fresh no-tree session.
 */
export async function findOrCreateLinkedSession(
  cwd: string,
  agentDir: string,
  sandboxMounts?: SandboxMounts,
): Promise<LinkedWorktreeSession> {
  return Effect.runPromise(
    findOrCreateLinkedSessionEffect(cwd, agentDir, sandboxMounts),
  );
}
