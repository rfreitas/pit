/**
 * Session IO — reads and writes pi session JSONL files.
 * All IO operations are Effect-based with platform services.
 */

import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";
import { FileSystem } from "@effect/platform/FileSystem";
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

/**
 * Scan the sessions directory for this cwd and return the most recent pit session.
 * Returns null if no pit session exists.
 */
export const findPitSession = (
  cwd: string,
  agentDir: string,
): Effect.Effect<{ sessionFile: string; meta: PitMetadata } | null> =>
  Effect.tryPromise({
    try: async () => {
      const sessionDir = join(agentDir, "sessions", cwdToBucket(cwd));
      const sessions = await SessionManager.list(cwd, sessionDir).catch(() => null);
      if (!sessions) return null;
      return [...sessions].sort((a, b) => b.modified.getTime() - a.modified.getTime())
        .reduce<{ sessionFile: string; meta: PitMetadata } | null>((found, session) => {
        if (found) return found;
        try {
          const sm = SessionManager.open(session.path);
          const entry = sm.getEntries().find(
            (e): e is CustomEntry<PitMetadata> =>
              e.type === "custom" && (e as CustomEntry).customType === "pit",
          );
          if (entry?.data) return { sessionFile: session.path, meta: entry.data };
        } catch { /* skip corrupt sessions */ }
        return null;
      }, null);
    },
    catch: () => null as never,
  });

// ── session creation ──────────────────────────────────────────────────────────

/**
 * Write a new session JSONL file pre-seeded with pit metadata and a visible
 * mode announcement. Returns the file path to pass as --session to pi.
 */
export const setupNewSession = (
  result: WorktreeResult,
  agentDir: string,
  sandboxMounts?: SandboxMounts,
): Effect.Effect<string, SessionWriteError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const bucket = cwdToBucket(result.cwd);
    const sessionDir = join(agentDir, "sessions", bucket);
    yield* fs.makeDirectory(sessionDir, { recursive: true }).pipe(
      Effect.mapError((e) => new SessionWriteError({ message: String(e) })),
    );

    const isoTs = new Date().toISOString();
    const fileTs = isoTs.replace(/:/g, "-").replace(".", "-");
    const sessionId = randomUUID();
    const sessionFile = join(sessionDir, `${fileTs}_${sessionId}.jsonl`);

    yield* fs.writeFileString(
      sessionFile,
      buildSessionLines(result, sessionId, isoTs, sandboxMounts),
    ).pipe(Effect.mapError((e) => new SessionWriteError({ message: String(e) })));

    return sessionFile;
  });

// ── linked-worktree session ───────────────────────────────────────────────────

/**
 * Find the existing pit session for cwd, or create a fresh no-tree session.
 */
export const findOrCreateLinkedSession = (
  cwd: string,
  agentDir: string,
  sandboxMounts?: SandboxMounts,
): Effect.Effect<LinkedWorktreeSession, SessionWriteError, FileSystem> =>
  Effect.gen(function* () {
    const existing = yield* findPitSession(cwd, agentDir);
    if (existing) {
      return { kind: "resume" as const, sessionFile: existing.sessionFile, meta: existing.meta };
    }
    const id = genId();
    const meta = buildNoTreeMeta(cwd, cwd, "linked-worktree", id, new Date().toISOString());
    const sessionFile = yield* setupNewSession({ mode: "no-tree", cwd, meta }, agentDir, sandboxMounts);
    return { kind: "new" as const, sessionFile, meta };
  });
