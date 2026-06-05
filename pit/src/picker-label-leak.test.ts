/**
 * Regression test: label leak bug — comprehensive test at scale.
 *
 * Tests:
 *  1. Many pruned sessions (9+) via scanSessionsByRepo — each keeps own label
 *  2. Active worktrees with session leakage from listSessions
 */
import { describe, it, expect } from "vitest";
import { useTmpDirs, writeSessionFile } from "./tests/helpers.ts";
import * as path from "node:path";
import { discoverSessionsForPicker, type PickerSession } from "./picker.ts";
import { scanSessionsByRepo } from "./core/session/io.ts";

const { makeSandbox } = useTmpDirs();

interface DiscoveryDeps {
  listSessions: (cwd: string) => Promise<PickerSession[]>;
  readWorktreeBranch: (wt: string) => Promise<string | null>;
  existsSync: (p: string) => boolean;
  branchExists: (branch: string) => Promise<boolean>;
  scanSessionsByRepo: (repo: string, agentDir: string) => Promise<PickerSession[]>;
}

describe("picker label leak at scale", () => {
  it("each of 9 pruned sessions keeps its own branch label", async () => {
    const agentDir = makeSandbox("picker-scale-");
    const repo = "/tmp/test-repo";

    // Create 9 sessions with distinct branches, all worktrees deleted
    const branches = [
      "feature/alpha", "feature/beta", "feature/gamma",
      "fix/bug-1", "fix/bug-2", "fix/bug-3",
      "pi/abc123", "pi/def456", "pi/ghi789",
    ];

    const sessions: Array<{ path: string; branch: string }> = [];
    for (let i = 0; i < branches.length; i++) {
      const wt = `/tmp/test-repo-wt-${String(i).padStart(8, "0")}`;
      const b = branches[i]!;
      const s = writeSessionFile(agentDir, wt, { repo, branch: b });
      sessions.push({ path: s.path, branch: b });
    }

    const deps: DiscoveryDeps = {
      listSessions: async () => [],
      readWorktreeBranch: async () => null,
      existsSync: () => false,
      branchExists: async () => true,
      scanSessionsByRepo,
    };

    const results = await discoverSessionsForPicker(
      { cwd: repo, repo, isLinked: false, worktrees: [], agentDir },
      deps,
    );

    expect(results).toHaveLength(branches.length);

    // Every result must have a label containing its OWN branch
    for (const r of results) {
      const label = (r.name ?? r.firstMessage ?? "").trim();
      expect(label).toContain("[missing worktree branch:");

      // Find the matching session
      const match = sessions.find((s) => s.path === r.path);
      expect(match, `session ${r.path} must exist`).toBeDefined();
      expect(label, `label for ${match!.branch} must contain its own branch`).toContain(match!.branch);
    }

    // No cross-contamination: no label should contain a branch it doesn't own
    const allLabels = results.map((r) => (r.name ?? r.firstMessage ?? "").trim());
    for (const r of results) {
      const match = sessions.find((s) => s.path === r.path)!;
      const ownLabel = (r.name ?? r.firstMessage ?? "").trim();
      // Count how many results have this branch's label
      const countWithThisBranch = allLabels.filter((l) => l.includes(match.branch)).length;
      expect(countWithThisBranch, `branch ${match.branch} should appear exactly once`).toBe(1);
    }
  });

  it("does NOT duplicate sessions when listSessions leaks across worktrees", async () => {
    // Simulate: SessionManager.list(wt) returns ALL sessions for ALL paths
    // This is the most likely real-world bug — pi's SessionManager.list
    // might not filter by cwd when sessionDir is undefined.
    const agentDir = makeSandbox("picker-leak3-");
    const repo = "/tmp/test-repo";

    const wt1 = "/tmp/test-repo-wt-leak1";
    const wt2 = "/tmp/test-repo-wt-leak2";
    const wt3 = "/tmp/test-repo-wt-leak3";

    // Sessions for 3 different worktrees, all dirs exist, all branches exist
    const sess1 = writeSessionFile(agentDir, wt1, { repo, branch: "feature/x" });
    const sess2 = writeSessionFile(agentDir, wt2, { repo, branch: "feature/y" });
    const sess3 = writeSessionFile(agentDir, wt3, { repo, branch: "feature/z" });

    // BUG SIMULATION: listSessions returns ALL sessions regardless of cwd
    // Include cwd so the labeling can match sessions to worktrees correctly
    const allSessions: PickerSession[] = [
      { path: sess1.path, modified: new Date(), cwd: wt1 },
      { path: sess2.path, modified: new Date(), cwd: wt2 },
      { path: sess3.path, modified: new Date(), cwd: wt3 },
    ];

    const deps: DiscoveryDeps = {
      listSessions: async () => allSessions, // LEAK: returns all for any cwd
      readWorktreeBranch: async (wt) => {
        if (wt === wt1) return "feature/x";
        if (wt === wt2) return "feature/y";
        if (wt === wt3) return "feature/z";
        return null;
      },
      existsSync: () => true,
      branchExists: async () => true,
      scanSessionsByRepo: async () => [],
    };

    const results = await discoverSessionsForPicker(
      { cwd: repo, repo, isLinked: false, worktrees: [wt1, wt2, wt3], agentDir },
      deps,
    );

    // BUG BEFORE FIX: without dedup, we'd get 12 entries (3 worktrees × 3 sessions each
    // in flatMarked + 3 in mainGroups). All sessions in each worktree group leak the
    // group's branch label onto unrelated sessions.
    //
    // AFTER FIX: dedup by path → exactly 3 unique sessions
    expect(results).toHaveLength(3);

    const sorted = [...results].sort((a, b) =>
      a.path.localeCompare(b.path),
    );

    const getLabel = (s: PickerSession): string =>
      (s.name ?? s.firstMessage ?? "").trim();

    // Each session must be present exactly once.
    // The label comes from flatMarked (first occurrence wins since flatMarked
    // comes before mainGroups in the dedup order), so they keep their labels.
    expect(getLabel(sorted[0]!)).toContain("feature/x");
    expect(getLabel(sorted[1]!)).toContain("feature/y");
    expect(getLabel(sorted[2]!)).toContain("feature/z");
  });
});
