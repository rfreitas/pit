/**
 * TDD tests for discoverSessionsForPicker (2.1 metadata.repo scan).
 *
 * Tests the extracted discovery function with mocked git and session layers.
 * Real temp files for session JSONL; everything else is mocked.
 */
import { describe, it, expect } from "vitest";
import { useTmpDirs } from "./tests/helpers.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildSessionLines, cwdToBucket } from "./core/session/pure.ts";
import type { WorktreeResult } from "./types.ts";

const { makeSandbox } = useTmpDirs();

// ── helpers ───────────────────────────────────────────────────────────────────

function writeSessionFile(
  agentDir: string,
  cwd: string,
  meta: { repo: string; branch: string },
): { path: string; modified: Date } {
  const bucket = cwdToBucket(cwd);
  const bucketDir = path.join(agentDir, "sessions", bucket);
  fs.mkdirSync(bucketDir, { recursive: true });

  const ts = new Date().toISOString();
  const fileTs = ts.replace(/:/g, "-").replace(".", "-");
  const sessionId = `test-${Math.random().toString(36).slice(2, 10)}`;
  const file = path.join(bucketDir, `${fileTs}_${sessionId}.jsonl`);

  const result: WorktreeResult = { cwd, meta };
  fs.writeFileSync(file, buildSessionLines(result, sessionId, ts));

  return { path: file, modified: new Date() };
}

import { discoverSessionsForPicker, type PickerSession } from "./program.ts";

// Mock deps that will be injected into discoverSessionsForPicker
interface DiscoveryDeps {
  listSessions: (cwd: string) => Promise<PickerSession[]>;
  readWorktreeBranch: (wt: string) => Promise<string | null>;
  existsSync: (p: string) => boolean;
  scanSessionsByRepo: (repo: string, agentDir: string) => Promise<PickerSession[]>;
}

// ═════════════════════════════════════════════════════════════════════════════
// TESTS
// ═════════════════════════════════════════════════════════════════════════════

describe("discoverSessionsForPicker", () => {
  it("finds sessions from git worktree list with live branch labels", async () => {
    const agentDir = makeSandbox("picker-");
    const repo = "/tmp/test-repo";
    const wt1 = "/tmp/test-repo-wt-abc123";

    // Session exists in worktree directory
    const session1 = writeSessionFile(agentDir, wt1, { repo, branch: "pi/abc123" });

    const deps: DiscoveryDeps = {
      listSessions: async (cwd) => {
        if (cwd === wt1) return [{ path: session1.path, modified: session1.modified }];
        return [];
      },
      readWorktreeBranch: async (wt) => (wt === wt1 ? "pi/abc123" : null),
      existsSync: () => true,
      scanSessionsByRepo: async () => [],
    };

    const results = await discoverSessionsForPicker(
      { cwd: "/tmp/test-repo", repo, isLinked: false, worktrees: [wt1], agentDir },
      deps,
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.path).toBe(session1.path);
    const labelField = results[0]!.name ?? results[0]!.firstMessage ?? "";
    expect(labelField).toContain("[worktree branch:pi/abc123]");
  });

  it("finds pruned worktree via metadata.repo scan (not in git worktree list)", async () => {
    const agentDir = makeSandbox("picker-");
    const repo = "/tmp/test-repo";
    const prunedWt = "/tmp/test-repo-wt-deadbeef";

    // Session file exists but worktree is NOT in git worktree list
    const session1 = writeSessionFile(agentDir, prunedWt, { repo, branch: "pi/deadbeef" });

    const deps: DiscoveryDeps = {
      listSessions: async () => [],
      readWorktreeBranch: async () => null,
      existsSync: () => false,
      scanSessionsByRepo: async (targetRepo, dir) => {
        const sessionsDir = path.join(dir, "sessions");
        const buckets = fs.readdirSync(sessionsDir);
        return buckets.flatMap((bucket) => {
          const bucketDir = path.join(sessionsDir, bucket);
          const files = fs.readdirSync(bucketDir)
            .filter((f) => f.endsWith(".jsonl"))
            .map((f) => ({ name: f, mtime: fs.statSync(path.join(bucketDir, f)).mtime }))
            .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
          if (!files.length) return [];
          const mostRecent = path.join(bucketDir, files[0]!.name);
          const lines = fs.readFileSync(mostRecent, "utf8").split("\n");
          const pitLine = lines.find((l) => {
            try {
              const e = JSON.parse(l) as Record<string, unknown>;
              return e["type"] === "custom" && e["customType"] === "pit";
            } catch { return false; }
          });
          if (!pitLine) return [];
          const entry = JSON.parse(pitLine) as { data?: { repo?: string; branch?: string } };
          return entry.data?.repo === targetRepo
            ? [{ path: mostRecent, modified: files[0]!.mtime }]
            : [];
        });
      },
    };

    const results = await discoverSessionsForPicker(
      { cwd: "/tmp/test-repo", repo, isLinked: false, worktrees: [], agentDir },
      deps,
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.path).toBe(session1.path);
  });

  it("excludes sessions whose metadata.repo does not match current repo", async () => {
    const agentDir = makeSandbox("picker-");
    const currentRepo = "/tmp/test-repo";
    const otherRepo = "/tmp/other-repo";
    const wtOther = "/tmp/other-repo-wt-12345";

    writeSessionFile(agentDir, wtOther, { repo: otherRepo, branch: "pi/12345" });

    const deps: DiscoveryDeps = {
      listSessions: async () => [],
      readWorktreeBranch: async () => null,
      existsSync: () => false,
      scanSessionsByRepo: async (targetRepo, dir) => {
        const sessionsDir = path.join(dir, "sessions");
        return fs.readdirSync(sessionsDir).flatMap((bucket) => {
          const bucketDir = path.join(sessionsDir, bucket);
          const files = fs.readdirSync(bucketDir)
            .filter((f) => f.endsWith(".jsonl"))
            .map((f) => ({ name: f, mtime: fs.statSync(path.join(bucketDir, f)).mtime }))
            .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
          if (!files.length) return [];
          const mostRecent = path.join(bucketDir, files[0]!.name);
          const lines = fs.readFileSync(mostRecent, "utf8").split("\n");
          const pitLine = lines.find((l) => {
            try {
              const e = JSON.parse(l) as Record<string, unknown>;
              return e["type"] === "custom" && e["customType"] === "pit";
            } catch { return false; }
          });
          if (!pitLine) return [];
          const entry = JSON.parse(pitLine) as { data?: { repo?: string } };
          return entry.data?.repo === targetRepo
            ? [{ path: mostRecent, modified: files[0]!.mtime }]
            : [];
        });
      },
    };

    const results = await discoverSessionsForPicker(
      { cwd: "/tmp/test-repo", repo: currentRepo, isLinked: false, worktrees: [], agentDir },
      deps,
    );

    expect(results).toHaveLength(0);
  });

  it("deduplicates when session appears in both git list and metadata scan", async () => {
    const agentDir = makeSandbox("picker-");
    const repo = "/tmp/test-repo";
    const wt1 = "/tmp/test-repo-wt-abc123";

    const session1 = writeSessionFile(agentDir, wt1, { repo, branch: "pi/abc123" });

    const deps: DiscoveryDeps = {
      listSessions: async (cwd) => {
        if (cwd === wt1) return [{ path: session1.path, modified: session1.modified }];
        return [];
      },
      readWorktreeBranch: async (wt) => (wt === wt1 ? "pi/abc123" : null),
      existsSync: () => true,
      scanSessionsByRepo: async () => [{
        path: session1.path,
        modified: session1.modified,
      }],
    };

    const results = await discoverSessionsForPicker(
      { cwd: "/tmp/test-repo", repo, isLinked: false, worktrees: [wt1], agentDir },
      deps,
    );

    expect(results).toHaveLength(1);
  });

  it("shows warning icon (⚠) when worktree dir exists but branch read fails", async () => {
    const agentDir = makeSandbox("picker-");
    const repo = "/tmp/test-repo";
    const wt1 = "/tmp/test-repo-wt-bad";

    const session1 = writeSessionFile(agentDir, wt1, { repo, branch: "pi/bad" });

    const deps: DiscoveryDeps = {
      listSessions: async (cwd) => {
        if (cwd === wt1) return [{ path: session1.path, modified: session1.modified }];
        return [];
      },
      readWorktreeBranch: async () => null, // dir exists but not a proper linked worktree
      existsSync: () => true,
      scanSessionsByRepo: async () => [],
    };

    const results = await discoverSessionsForPicker(
      { cwd: "/tmp/test-repo", repo, isLinked: false, worktrees: [wt1], agentDir },
      deps,
    );

    expect(results).toHaveLength(1);
    const labelField2 = results[0]!.name ?? results[0]!.firstMessage ?? "";
    expect(labelField2).toContain("⚠");
  });

  it("when isLinked=true, returns only sessions for current cwd (worktree isolation)", async () => {
    const agentDir = makeSandbox("picker-");
    const currentWt = "/tmp/test-repo-wt-current";
    const siblingWt = "/tmp/test-repo-wt-sibling";

    const sessionCurrent = writeSessionFile(agentDir, currentWt, { repo: "/tmp/test-repo", branch: "pi/current" });
    writeSessionFile(agentDir, siblingWt, { repo: "/tmp/test-repo", branch: "pi/sibling" });

    const deps: DiscoveryDeps = {
      listSessions: async (cwd) => {
        if (cwd === currentWt) return [{ path: sessionCurrent.path, modified: sessionCurrent.modified }];
        return [];
      },
      readWorktreeBranch: async () => null,
      existsSync: () => true,
      scanSessionsByRepo: async () => [],
    };

    const results = await discoverSessionsForPicker(
      { cwd: currentWt, repo: "/tmp/test-repo", isLinked: true, worktrees: [currentWt, siblingWt], agentDir },
      deps,
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.path).toBe(sessionCurrent.path);
  });
});
