/**
 * Session IO — reads and writes pi session JSONL files.
 * All IO operations are Effect-based with platform services.
 */

import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";
import { FileSystem } from "@effect/platform/FileSystem";
import { SessionManager, type CustomEntry } from "@earendil-works/pi-coding-agent";
import type {
  PitMetadata,
  WorktreeResult,
  SandboxMounts,
  LinkedWorktreeSession,
} from "../../types.ts";
import { cwdToBucket, buildSessionLines } from "./pure.ts";
import { buildNoTreeMeta } from "../worktree/pure.ts";
import { SessionWriteError } from "../../errors.ts";

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

// ── metadata scan for pruned worktrees (picker 2.1) ────────────────────────────

/**
 * Scan all session buckets and return sessions whose pit metadata.repo
 * matches the given repo. Used by the picker to discover pruned worktrees
 * that no longer appear in `git worktree list`.
 *
 * Returns basic SessionInfo (path + modified) for each matching session.
 * The caller (discoverSessionsForPicker) applies labels and deduplicates.
 */
export const scanSessionsByRepo = async (
  repo: string,
  agentDir: string,
): Promise<Array<{ path: string; modified: Date; firstMessage: string; messageCount: number; cwd: string | null }>> => {
  const sessionsDir = join(agentDir, "sessions");
  const { readdir, readFile, stat } = await import("node:fs/promises");

  let buckets: string[] = [];
  try { buckets = await readdir(sessionsDir); } catch { return []; }

  let found: Array<{ path: string; modified: Date; firstMessage: string; messageCount: number; cwd: string | null }> = [];

  for (const bucket of buckets) {
    const bucketDir = join(sessionsDir, bucket);
    let files: string[] = [];
    try { files = await readdir(bucketDir); } catch { continue; }

    const jsonlFiles = (await Promise.all(
      files.map(async (f) => {
        if (!f.endsWith(".jsonl")) return null;
        try {
          const s = await stat(join(bucketDir, f));
          return { name: f, mtime: s.mtime };
        } catch { return null; }
      }),
    )).filter((x): x is { name: string; mtime: Date } => x !== null)
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    if (!jsonlFiles.length) continue;

    const mostRecent = join(bucketDir, jsonlFiles[0]!.name);

    const scanResult = await (async () => {
      try {
        const content = await readFile(mostRecent, "utf8");
        const lines = content.split("\n").filter((l) => l.trim());

        // Extract cwd from session header (first line)
        let cwd: string | null = null;
        try {
          const header = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
          if (header["type"] === "session") cwd = (header["cwd"] as string) ?? null;
        } catch { /* ignore */ }

        // Count model_change entries as a proxy for messageCount
        const messageCount = lines.filter((l) => {
          try {
            const e = JSON.parse(l) as Record<string, unknown>;
            return e["type"] === "model_change";
          } catch { return false; }
        }).length;

        const pitLine = lines.find((l) => {
          try {
            const e = JSON.parse(l) as Record<string, unknown>;
            return e["type"] === "custom" && e["customType"] === "pit";
          } catch { return false; }
        });
        if (!pitLine) return null;
        const entry = JSON.parse(pitLine) as { data?: { repo?: string; branch?: string } };
        if (entry.data?.repo !== repo) return null;
        const branch = entry.data?.branch ?? "unknown";
        return {
          path: mostRecent,
          modified: jsonlFiles[0]!.mtime,
          firstMessage: `[pruned worktree branch:${branch}]`,
          messageCount,
          cwd,
        };
      } catch { return null; }
    })();

    if (scanResult) {
      found = [...found, scanResult];
    }
  }

  return found;
};

// ── cache refresh ───────────────────────────────────────────────────────────────

/**
 * Rewrite the pit CustomEntry's branch in the session file if it differs
 * from freshBranch. Returns true if a rewrite was performed.
 * Safe to call before pi starts — no concurrent writer at that point.
 */
export const refreshPitBranchIfStaleSync = (sessionFile: string, freshBranch: string): boolean => {
  try {
    const content = readFileSync(sessionFile, "utf8");
    const lines = content.split("\n");
    const updated = lines.map((l: string) => {
      if (!l || !l.trim()) return l;
      try {
        const e = JSON.parse(l) as Record<string, unknown>;
        if (e["type"] === "custom" && e["customType"] === "pit") {
          const entry = e as { data?: { branch?: string } };
          if (entry.data?.branch !== freshBranch) {
            return JSON.stringify({
              ...e,
              data: { ...((e.data as object) || {}), branch: freshBranch },
            });
          }
        }
      } catch { /* skip */ }
      return l;
    });

    const updatedContent = updated.join("\n");
    if (updatedContent !== content) {
      writeFileSync(sessionFile, updatedContent);
      return true;
    }
  } catch { /* ignore read/write errors */ }
  return false;
};

export const refreshPitBranchIfStale = (
  sessionFile: string,
  freshBranch: string,
): Effect.Effect<boolean, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const content = yield* fs.readFileString(sessionFile).pipe(
      Effect.orElse(() => Effect.succeed("")),
    );
    const lines = content.split("\n");
    const pitIdx = lines.findIndex((l) => {
      if (!l.trim()) return false;
      try {
        const e = JSON.parse(l) as Record<string, unknown>;
        return e["type"] === "custom" && e["customType"] === "pit";
      } catch { return false; }
    });
    if (pitIdx === -1) return false;
    const entry = JSON.parse(lines[pitIdx]!) as {
      data?: { branch?: string; [k: string]: unknown };
      [k: string]: unknown;
    };
    if (entry.data?.branch === freshBranch) return false; // already fresh
    const updated = lines.map((l, i) =>
      i === pitIdx ? JSON.stringify({ ...entry, data: { ...entry.data, branch: freshBranch } }) : l,
    );
    yield* fs.writeFileString(sessionFile, updated.join("\n")).pipe(
      Effect.orElse(() => Effect.void),
    );
    return true;
  });

// ── session creation ──────────────────────────────────────────────────────────

/**
 * Write a new session JSONL file pre-seeded with pit metadata and a visible
 * mode announcement. Returns the file path to pass as --session to pi.
 */
export const setupNewSession = (
  result: Readonly<WorktreeResult>,
  agentDir: string,
  sandboxMounts?: Readonly<SandboxMounts>,
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
    const meta = buildNoTreeMeta(cwd);
    const sessionFile = yield* setupNewSession({ cwd, meta }, agentDir, sandboxMounts);
    return { kind: "new" as const, sessionFile, meta };
  });
