/**
 * TUI Integration tests for the pit session picker.
 *
 * This file verifies that our discovery logic (`discoverSessionsForPicker`)
 * produces output that perfectly satisfies the `SessionSelectorComponent`
 * render contract.
 *
 * We instantiate the actual TUI component, feed it our discovered sessions,
 * and call `.render(100)` to assert against the final string output.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { useTmpDirs, writeSessionFile } from "../src/tests/helpers.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { discoverSessionsForPicker } from "../src/picker/index.ts";
import { scanSessionsByRepo } from "../src/core/session/io.ts";
import { SessionSelectorComponent, initTheme } from "@earendil-works/pi-coding-agent";

const { makeSandbox } = useTmpDirs();

// ── Helpers ───────────────────────────────────────────────────────────────────

beforeAll(() => {
  initTheme(); // Required by TUI components
});

/** Helper to run discovery -> component -> render */
async function getRenderedPickerUI(
  opts: any,
  deps: any,
): Promise<string> {
  const sessions = await discoverSessionsForPicker(opts, {
    branchExists: async () => true,
    ...deps
  });
  
  const comp = new SessionSelectorComponent(
    async () => sessions as any,
    async () => [],
    () => {}, () => {}, () => {}, () => {}
  );
  
  // Wait for the async loaders inside SessionSelectorComponent to resolve
  await new Promise((r) => setTimeout(r, 100));
  
  // Render at 100 columns width
  return comp.render(100).join("\n");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Picker TUI integration", () => {
  
  it("Feature 2.1: Pruned worktrees are discovered and rendered without crashing", async () => {
    const agentDir = makeSandbox("tui-pruned-");
    const repo = "/tmp/repo";
    const prunedWt = "/tmp/repo-wt-pruned";

    // Create session file, but do NOT include it in worktrees array (simulate pruned)
    writeSessionFile(agentDir, prunedWt, { repo, branch: "pi/pruned-branch" });

    const ui = await getRenderedPickerUI(
      { cwd: "/tmp/repo", repo, isLinked: false, worktrees: [], agentDir },
      {
        listSessions: async () => [],
        readWorktreeBranch: async () => null,
        existsSync: () => false,
        // Use the real implementation to test file IO + parsing
        scanSessionsByRepo: (r: string, a: string) => scanSessionsByRepo(r, a),
      }
    );

    // If it didn't crash, verify the UI contains the expected fallback label
    expect(ui).toContain("pi/pruned-branch");
  });

  it("Feature 2.2: Live labels are applied to active worktree sessions", async () => {
    const activeWt = "/tmp/repo-wt-active";
    
    const ui = await getRenderedPickerUI(
      { cwd: "/tmp/repo", repo: "/tmp/repo", isLinked: false, worktrees: [activeWt], agentDir: "/tmp/agent" },
      {
        listSessions: async (cwd: string) => cwd === activeWt ? [{
          path: "/tmp/fake.jsonl",
          firstMessage: "I am a session",
          modified: new Date(),
          messageCount: 4,
          cwd: activeWt
        }] : [],
        // Mock git returning the live branch
        readWorktreeBranch: async () => "pi/live-branch-name",
        existsSync: () => true,
        scanSessionsByRepo: async () => [],
      }
    );

    // The UI should show the branch label injected by our logic
    expect(ui).toContain("[worktree branch:pi/live-branch-name]");
    expect(ui).toContain("I am a session");
  });

  it("Feature 2.3: Worktree isolation (isLinked=true)", async () => {
    const currentWt = "/tmp/repo-wt-current";
    const siblingWt = "/tmp/repo-wt-sibling";

    const ui = await getRenderedPickerUI(
      // We are INSIDE currentWt, so isLinked is true
      { cwd: currentWt, repo: "/tmp/repo", isLinked: true, worktrees: [currentWt, siblingWt], agentDir: "/tmp/agent" },
      {
        listSessions: async (cwd: string) => {
          if (cwd === currentWt) return [{ path: "/tmp/current.jsonl", firstMessage: "Current WT", modified: new Date(), cwd }];
          if (cwd === siblingWt) return [{ path: "/tmp/sibling.jsonl", firstMessage: "Sibling WT", modified: new Date(), cwd }];
          return [];
        },
        readWorktreeBranch: async () => "pi/some-branch",
        existsSync: () => true,
        scanSessionsByRepo: async () => [],
      }
    );

    // Should ONLY render the current worktree's session
    expect(ui).toContain("Current WT");
    expect(ui).not.toContain("Sibling WT");
  });

  it("Feature 2.4: Warning icon (⚠) for dir-exists-but-not-linked", async () => {
    const badWt = "/tmp/repo-wt-bad";

    const ui = await getRenderedPickerUI(
      { cwd: "/tmp/repo", repo: "/tmp/repo", isLinked: false, worktrees: [badWt], agentDir: "/tmp/agent" },
      {
        listSessions: async (cwd: string) => cwd === badWt ? [{
          path: "/tmp/bad.jsonl",
          firstMessage: "Bad WT",
          modified: new Date(), cwd
        }] : [],
        // Mock git returning null (branch lost) but existsSync returning true
        readWorktreeBranch: async () => null,
        existsSync: () => true,
        branchExists: async () => false, // deleted branch
        scanSessionsByRepo: async () => [],
      }
    );

    expect(ui).toContain("⚠");
    expect(ui).toContain("⚠ [deleted branch] Bad WT");
  });

  it("Feature 2.5: Prevents session duplication and label leaking at the TUI level", async () => {
    // This reproduces your exact scenario at the TUI rendering level.
    const wt1 = "/tmp/repo-wt-111";
    const wt2 = "/tmp/repo-wt-222";

    const session1 = { path: "/tmp/sess1.jsonl", firstMessage: "Message from Branch 1", modified: new Date(), cwd: wt1 };
    const session2 = { path: "/tmp/sess2.jsonl", firstMessage: "Message from Branch 2", modified: new Date(Date.now() - 1000), cwd: wt2 };

    const ui = await getRenderedPickerUI(
      { cwd: "/tmp/repo", repo: "/tmp/repo", isLinked: false, worktrees: [wt1, wt2], agentDir: "/tmp/agent" },
      {
        // BUG SIMULATION: listSessions leaks and returns ALL sessions for EVERY call
        listSessions: async () => [session1, session2] as any,
        readWorktreeBranch: async (wt: string) => wt === wt1 ? "pi/branch1" : "pi/branch2",
        existsSync: () => true,
        branchExists: async () => true,
        scanSessionsByRepo: async () => [],
      }
    );

    // 1. Label Correctness: each message should get exactly its own branch label
    expect(ui).toContain("[worktree branch:pi/branch1] Message from Branch 1");
    expect(ui).toContain("[worktree branch:pi/branch2] Message from Branch 2");

    // 2. Cross-Contamination: no message should get the other branch's label
    expect(ui).not.toContain("[worktree branch:pi/branch1] Message from Branch 2");
    expect(ui).not.toContain("[worktree branch:pi/branch2] Message from Branch 1");

    // 3. Duplication check: the strings should only appear exactly once in the rendered output
    const countOccurrences = (str: string, substr: string) => str.split(substr).length - 1;
    expect(countOccurrences(ui, "Message from Branch 1")).toBe(1);
    expect(countOccurrences(ui, "Message from Branch 2")).toBe(1);
  });

  it("Ensures the render contract does NOT crash on undefined name/firstMessage", async () => {
    // This verifies that even if we discover a session that lacks display fields,
    // the picker remains robust and renders with a clean default instead of crashing.
    const ui = await getRenderedPickerUI(
      { cwd: "/tmp/repo", repo: "/tmp/repo", isLinked: false, worktrees: [], agentDir: "/tmp/agent" },
      {
        listSessions: async () => [],
        readWorktreeBranch: async () => null,
        existsSync: () => false,
        // Mock a minimal scanned object lacking firstMessage and name
        scanSessionsByRepo: async () => [{ path: "/tmp/crash.jsonl", modified: new Date(), cwd: "/tmp/repo" } as any],
      }
    );

    expect(ui).toContain("(no messages)");
  });

});
