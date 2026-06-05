/**
 * TDD tests for discoverSessionsForPicker (2.1 metadata.repo scan).
 *
 * Tests the extracted discovery function with mocked git and session layers.
 * Real temp files for session JSONL; everything else is mocked.
 */
import { describe, it, expect } from "vitest";
import { useTmpDirs, writeSessionFile } from "./tests/helpers.ts";
import * as fs from "node:fs";
import * as path from "node:path";

const { makeSandbox } = useTmpDirs();

// ── helpers ───────────────────────────────────────────────────────────────────


import { discoverSessionsForPicker, type PickerSession } from "./picker.ts";

// Mock deps that will be injected into discoverSessionsForPicker
interface DiscoveryDeps {
  listSessions: (cwd: string) => Promise<PickerSession[]>;
  readWorktreeBranch: (wt: string) => Promise<string | null>;
  existsSync: (p: string) => boolean;
  branchExists: (branch: string) => Promise<boolean>;
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
        if (cwd === wt1) return [{ sessionFilePath: session1.path, modified: session1.modified }];
        return [];
      },
      readWorktreeBranch: async (wt) => (wt === wt1 ? "pi/abc123" : null),
      existsSync: () => true,
      branchExists: async () => true,
      scanSessionsByRepo: async () => [],
    };

    const results = await discoverSessionsForPicker(
      { cwd: "/tmp/test-repo", repo, isLinked: false, worktrees: [wt1], agentDir },
      deps,
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.sessionFilePath).toBe(session1.path);
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
      branchExists: async () => true,
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
            ? [{ sessionFilePath: mostRecent, modified: files[0]!.mtime }]
            : [];
        });
      },
    };

    const results = await discoverSessionsForPicker(
      { cwd: "/tmp/test-repo", repo, isLinked: false, worktrees: [], agentDir },
      deps,
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.sessionFilePath).toBe(session1.path);
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
      branchExists: async () => true,
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
            ? [{ sessionFilePath: mostRecent, modified: files[0]!.mtime }]
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
        if (cwd === wt1) return [{ sessionFilePath: session1.path, modified: session1.modified }];
        return [];
      },
      readWorktreeBranch: async (wt) => (wt === wt1 ? "pi/abc123" : null),
      existsSync: () => true,
      branchExists: async () => true,
      scanSessionsByRepo: async () => [{
        sessionFilePath: session1.path,
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
        if (cwd === wt1) return [{ sessionFilePath: session1.path, modified: session1.modified }];
        return [];
      },
      readWorktreeBranch: async () => null, // dir exists but not a proper linked worktree
      existsSync: () => true,
      branchExists: async () => false,
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

  it("does NOT duplicate sessions when repo and cwd are the same path (mainPaths dedup)", async () => {
    // Regression: when running pit -r from the main repo directory,
    // opts.repo === opts.cwd, which causes mainPaths = [cwd, cwd].
    // Without dedup, listSessions is called twice with the same cwd,
    // producing duplicate entries in the picker.
    const agentDir = makeSandbox("picker-");
    const repoDir = "/tmp/test-repo";

    // Write a session in the repo directory itself (not a worktree).
    // This simulates running pit -r from the repo root — sessions live
    // in the repo's own bucket.
    const session1 = writeSessionFile(agentDir, repoDir, { repo: repoDir, branch: "" });

    // Track how many times listSessions is called for each cwd
    const listCalls = new Map<string, number>();

    const deps: DiscoveryDeps = {
      listSessions: async (cwd) => {
        listCalls.set(cwd, (listCalls.get(cwd) ?? 0) + 1);
        if (cwd === repoDir) return [{ sessionFilePath: session1.path, modified: session1.modified }];
        return [];
      },
      readWorktreeBranch: async () => null,
      existsSync: () => true,
      branchExists: async () => true,
      scanSessionsByRepo: async () => [],
    };

    const results = await discoverSessionsForPicker(
      // repo === cwd — simulating pit -r from the main repo root
      { cwd: repoDir, repo: repoDir, isLinked: false, worktrees: [], agentDir },
      deps,
    );

    // BUG: mainPaths = [repo, cwd] = [repoDir, repoDir]
    // listSessions is called twice for the same directory, producing duplicates.
    // The session appears twice in results (2 instead of 1).
    expect(results.length, "each session should appear only once").toBe(1);
    expect(results[0]!.sessionFilePath).toBe(session1.path);
  });

  it("when isLinked=true, returns only sessions for current cwd (worktree isolation)", async () => {
    const agentDir = makeSandbox("picker-");
    const currentWt = "/tmp/test-repo-wt-current";
    const siblingWt = "/tmp/test-repo-wt-sibling";

    const sessionCurrent = writeSessionFile(agentDir, currentWt, { repo: "/tmp/test-repo", branch: "pi/current" });
    writeSessionFile(agentDir, siblingWt, { repo: "/tmp/test-repo", branch: "pi/sibling" });

    const deps: DiscoveryDeps = {
      listSessions: async (cwd) => {
        if (cwd === currentWt) return [{ sessionFilePath: sessionCurrent.path, modified: sessionCurrent.modified }];
        return [];
      },
      readWorktreeBranch: async () => null,
      existsSync: () => true,
      branchExists: async () => true,
      scanSessionsByRepo: async () => [],
    };

    const results = await discoverSessionsForPicker(
      { cwd: currentWt, repo: "/tmp/test-repo", isLinked: true, worktrees: [currentWt, siblingWt], agentDir },
      deps,
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.sessionFilePath).toBe(sessionCurrent.path);
  });
});
