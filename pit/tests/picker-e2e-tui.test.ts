/**
 * End-to-End TUI integration tests for the pit session picker with real Git fixtures.
 *
 * Verifies that the real production discovery pipeline (with actual fs.existsSync,
 * git commands, and scanSessionsByRepo file IO) correctly populates the
 * SessionSelectorComponent and renders the terminal layout cleanly for all 5 row states.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { buildSessionLines, cwdToBucket } from "../src/core/session/pure.ts";
import { discoverSessionsForPicker } from "../src/program.ts";
import { scanSessionsByRepo } from "../src/core/session/io.ts";
import { SessionSelectorComponent, initTheme } from "@earendil-works/pi-coding-agent";
import type { WorktreeResult } from "../src/types.ts";

beforeAll(() => {
  initTheme(); // Initialize TUI rendering engine styles
});

// ── Git & FS Fixture Generator ────────────────────────────────────────────────

interface GitE2EFixture {
  tempDir: string;
  repoPath: string;
  agentDir: string;
  cleanup: () => void;
  writeSession: (cwd: string, branch: string, firstMessage?: string) => string;
  addWorktree: (branchName: string, pathName: string) => string;
  deleteLocalBranch: (branchName: string) => void;
}

function createGitE2EFixture(): GitE2EFixture {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pit-e2e-tui-"));
  const repoPath = path.join(tempDir, "repo");
  const agentDir = path.join(tempDir, "agent");

  fs.mkdirSync(repoPath);
  fs.mkdirSync(agentDir);

  // Initialize a real Git repository with a default branch and a dummy commit
  execSync("git init -b main", { cwd: repoPath, stdio: "ignore" });
  execSync("git config user.name 'Test User'", { cwd: repoPath, stdio: "ignore" });
  execSync("git config user.email 'test@user.com'", { cwd: repoPath, stdio: "ignore" });
  fs.writeFileSync(path.join(repoPath, "dummy.txt"), "hello world");
  execSync("git add dummy.txt && git commit -m 'initial commit'", { cwd: repoPath, stdio: "ignore" });

  const addWorktree = (branchName: string, pathName: string): string => {
    const wtPath = path.join(tempDir, pathName);
    execSync(`git worktree add -b ${branchName} ${wtPath}`, { cwd: repoPath, stdio: "ignore" });
    return wtPath;
  };

  const deleteLocalBranch = (branchName: string): void => {
    try {
      execSync(`git update-ref -d refs/heads/${branchName}`, { cwd: repoPath, stdio: "ignore" });
    } catch {}
  };

  const writeSession = (cwd: string, branch: string, firstMessage = "This is a test session"): string => {
    const bucket = cwdToBucket(cwd);
    const bucketDir = path.join(agentDir, "sessions", bucket);
    fs.mkdirSync(bucketDir, { recursive: true });

    const ts = new Date().toISOString();
    const fileTs = ts.replace(/:/g, "-").replace(".", "-");
    const sessionId = `test-${Math.random().toString(36).slice(2, 10)}`;
    const sessionFile = path.join(bucketDir, `${fileTs}_${sessionId}.jsonl`);

    const result: WorktreeResult = {
      cwd,
      meta: { repo: repoPath, branch },
    };

    // Construct valid JSONL session file lines
    const headerLine = JSON.stringify({
      type: "session",
      id: sessionId,
      cwd,
      version: 1,
    });
    const pitLine = JSON.stringify({
      type: "custom",
      customType: "pit",
      id: "pit-entry-id",
      parentId: null,
      data: result.meta,
    });
    const msgLine = JSON.stringify({
      type: "message",
      id: "msg-id",
      parentId: "pit-entry-id",
      message: {
        role: "user",
        content: firstMessage,
      },
    });

    fs.writeFileSync(sessionFile, `${headerLine}\n${pitLine}\n${msgLine}\n`);
    return sessionFile;
  };

  const cleanup = () => {
    try {
      execSync("git worktree prune", { cwd: repoPath, stdio: "ignore" });
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  };

  return { tempDir, repoPath, agentDir, cleanup, writeSession, addWorktree, deleteLocalBranch };
};

/** Helper to run discovery -> TUI component load -> render to string */
async function getRenderedPickerUI(
  opts: { cwd: string; repo: string; isLinked: boolean; worktrees: string[]; agentDir: string },
): Promise<string> {
  // Use production deps
  const deps = {
    listSessions: async (cwd: string) => {
      const bucket = cwdToBucket(cwd);
      const bucketDir = path.join(opts.agentDir, "sessions", bucket);
      if (!fs.existsSync(bucketDir)) return [];
      const files = fs.readdirSync(bucketDir).filter((f) => f.endsWith(".jsonl"));
      return files.map((f) => {
        const full = path.join(bucketDir, f);
        const s = fs.statSync(full);
        const lines = fs.readFileSync(full, "utf8").split("\n").filter((l) => l.trim());
        
        let parsedCwd: string | null = null;
        let firstMessage = "";

        const extractText = (content: any): string => {
          if (typeof content === "string") return content;
          if (Array.isArray(content)) {
            return content
              .map((c) => (c && typeof c === "object" && c.type === "text" ? c.text : ""))
              .join("")
              .trim();
          }
          return "";
        };

        for (const line of lines) {
          try {
            const e = JSON.parse(line);
            if (e.type === "session") {
              parsedCwd = e.cwd ?? null;
            } else if (e.type === "message" && !firstMessage && e.message?.role === "user") {
              firstMessage = extractText(e.message.content);
            }
          } catch {}
        }

        return {
          path: full,
          modified: s.mtime,
          firstMessage: firstMessage || "(no messages)",
          messageCount: lines.length - 2,
          cwd: parsedCwd,
        };
      });
    },
    readWorktreeBranch: async (wt: string) => {
      const gitPath = path.join(wt, ".git");
      try {
        if (!fs.existsSync(gitPath)) return null;
        const stat = fs.statSync(gitPath);
        if (!stat.isFile()) return null;
        const content = fs.readFileSync(gitPath, "utf8").trim();
        const gitdir = content.replace(/^gitdir:\s*/, "");
        const head = fs.readFileSync(path.join(gitdir, "HEAD"), "utf8").trim();
        const m = head.match(/^ref:\s*refs\/heads\/(\S+)$/);
        return m?.[1] ?? null;
      } catch {
        return null;
      }
    },
    existsSync: (p: string) => fs.existsSync(p),
    branchExists: async (branch: string) => {
      try {
        execSync(`git show-ref --verify refs/heads/${branch}`, { cwd: opts.repo, stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    },
    scanSessionsByRepo: (repo: string, agentDir: string) => scanSessionsByRepo(repo, agentDir),
  };

  const sessions = await discoverSessionsForPicker(opts, deps);

  const comp = new SessionSelectorComponent(
    async () => sessions as any,
    async () => [],
    () => {}, () => {}, () => {}, () => {}
  );

  // Wait for the asynchronous loader inside SessionSelectorComponent to resolve
  await new Promise((r) => setTimeout(r, 80));

  return comp.render(100).join("\n");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("E2E TUI Picker (Zero Mocks with Real Git & FS Fixtures)", () => {

  it("Test 1: Row 1 — Active Worktree (Healthy)", async () => {
    const f = createGitE2EFixture();
    try {
      const wt = f.addWorktree("pi/feature-active", "wt-active");
      f.writeSession(wt, "pi/feature-active", "Active worktree description");

      const ui = await getRenderedPickerUI({
        cwd: f.repoPath,
        repo: f.repoPath,
        isLinked: false,
        worktrees: [wt],
        agentDir: f.agentDir,
      });

      expect(ui).toContain("[worktree branch:pi/feature-active] Active worktree description");
    } finally {
      f.cleanup();
    }
  });

  it("Test 2: Row 2 — Missing Worktree (Branch Exists)", async () => {
    const f = createGitE2EFixture();
    try {
      const wt = f.addWorktree("pi/missing-wt", "wt-missing");
      f.writeSession(wt, "pi/missing-wt", "Missing worktree but branch survives");

      // Delete the folder, but do NOT delete the branch
      fs.rmSync(wt, { recursive: true, force: true });

      const ui = await getRenderedPickerUI({
        cwd: f.repoPath,
        repo: f.repoPath,
        isLinked: false,
        worktrees: [], // Folder gone, unregistered in git list too
        agentDir: f.agentDir,
      });

      expect(ui).toContain("[missing worktree branch:pi/missing-wt] Missing worktree but branch survives");
    } finally {
      f.cleanup();
    }
  });

  it("Test 3: Row 3 — Deleted Branch (Folder Missing)", async () => {
    const f = createGitE2EFixture();
    try {
      const wt = f.addWorktree("pi/deleted-branch", "wt-deleted");
      f.writeSession(wt, "pi/deleted-branch", "Folder gone and branch deleted");

      // Delete both the folder AND the local branch
      fs.rmSync(wt, { recursive: true, force: true });
      f.deleteLocalBranch("pi/deleted-branch");

      const ui = await getRenderedPickerUI({
        cwd: f.repoPath,
        repo: f.repoPath,
        isLinked: false,
        worktrees: [],
        agentDir: f.agentDir,
      });

      expect(ui).toContain("[deleted branch:pi/deleted-branch] Folder gone and branch deleted");
    } finally {
      f.cleanup();
    }
  });

  it("Test 4: Row 4 — Deleted Branch (Folder Exists)", async () => {
    const f = createGitE2EFixture();
    try {
      const wt = f.addWorktree("pi/deleted-exists", "wt-exists");
      f.writeSession(wt, "pi/deleted-exists", "Folder stays but branch is deleted");

      // Delete the branch, but keep the folder on disk
      f.deleteLocalBranch("pi/deleted-exists");

      const ui = await getRenderedPickerUI({
        cwd: f.repoPath,
        repo: f.repoPath,
        isLinked: false,
        worktrees: [], // Unregistered, not listed in active worktrees list
        agentDir: f.agentDir,
      });

      expect(ui).toContain("⚠ [deleted branch:pi/deleted-exists] Folder stays but branch is deleted");
    } finally {
      f.cleanup();
    }
  });

  it("Test 5: Row 5 — Unregistered Worktree (Folder Exists, Branch Exists)", async () => {
    const f = createGitE2EFixture();
    try {
      const wt = f.addWorktree("pi/unregistered", "wt-unreg");
      f.writeSession(wt, "pi/unregistered", "Folder and branch stay, but link broken");

      // Corrupt/unlink the worktree link by deleting .git, making it unregistered
      fs.unlinkSync(path.join(wt, ".git"));

      const ui = await getRenderedPickerUI({
        cwd: f.repoPath,
        repo: f.repoPath,
        isLinked: false,
        worktrees: [], // Unregistered, not listed in active worktrees list
        agentDir: f.agentDir,
      });

      expect(ui).toContain("⚠ [unregistered worktree:pi/unregistered] Folder and branch stay, but link broken");
    } finally {
      f.cleanup();
    }
  });

});
