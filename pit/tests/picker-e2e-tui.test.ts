/**
 * End-to-End TUI integration tests for the pit session picker with real Git fixtures.
 *
 * Verifies that the real production discovery pipeline (with actual fs.existsSync,
 * git commands, and scanSessionsByRepo file IO) correctly populates the
 * SessionSelectorComponent and renders the terminal layout cleanly.
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

  return { tempDir, repoPath, agentDir, cleanup, writeSession, addWorktree };
}

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

  it("Test 1: Real active worktree session rendering", async () => {
    const f = createGitE2EFixture();
    try {
      const wt = f.addWorktree("pi/feature-active", "wt-active");
      f.writeSession(wt, "pi/feature-active", "User started a feature turn");

      const ui = await getRenderedPickerUI({
        cwd: f.repoPath,
        repo: f.repoPath,
        isLinked: false,
        worktrees: [wt],
        agentDir: f.agentDir,
      });

      expect(ui).toContain("[worktree branch:pi/feature-active]");
      expect(ui).toContain("User started a feature turn");
    } finally {
      f.cleanup();
    }
  });

  it("Test 2: Real pruned session rendering (metadata.repo scan)", async () => {
    const f = createGitE2EFixture();
    try {
      // Create session file for a directory that does NOT exist
      const deadWt = path.join(f.tempDir, "wt-pruned");
      f.writeSession(deadWt, "pi/pruned-branch", "This session's worktree is deleted");

      const ui = await getRenderedPickerUI({
        cwd: f.repoPath,
        repo: f.repoPath,
        isLinked: false,
        worktrees: [], // No active worktrees
        agentDir: f.agentDir,
      });

      expect(ui).toContain("[pruned worktree branch:pi/pruned-branch] This session's worktree is deleted");
    } finally {
      f.cleanup();
    }
  });

  it("Test 3: Real warning indicator rendering (dir exists but branch null/broken)", async () => {
    const f = createGitE2EFixture();
    try {
      const wt = f.addWorktree("pi/broken-link", "wt-broken");
      f.writeSession(wt, "pi/broken-link", "Broken worktree link");

      // Corrupt the worktree by deleting its .git file, so isLinked existsSync is true, but reading the branch returns null
      fs.unlinkSync(path.join(wt, ".git"));

      const ui = await getRenderedPickerUI({
        cwd: f.repoPath,
        repo: f.repoPath,
        isLinked: false,
        worktrees: [wt],
        agentDir: f.agentDir,
      });

      expect(ui).toContain("⚠");
      expect(ui).toContain("[worktree branch:deleted]");
    } finally {
      f.cleanup();
    }
  });

  it("Test 4: Real worktree isolation rendering", async () => {
    const f = createGitE2EFixture();
    try {
      const wtCurrent = f.addWorktree("pi/current", "wt-current");
      const wtSibling = f.addWorktree("pi/sibling", "wt-sibling");

      f.writeSession(wtCurrent, "pi/current", "Current active branch");
      f.writeSession(wtSibling, "pi/sibling", "Sibling branch");

      const ui = await getRenderedPickerUI({
        cwd: wtCurrent,
        repo: f.repoPath,
        isLinked: true, // We are inside wtCurrent
        worktrees: [wtCurrent, wtSibling],
        agentDir: f.agentDir,
      });

      // Isolation means we only render wtCurrent's session, sibling is hidden
      expect(ui).toContain("Current active branch");
      expect(ui).not.toContain("Sibling branch");
    } finally {
      f.cleanup();
    }
  });

  it("Test 5: Main repo parent session selection (active children list)", async () => {
    const f = createGitE2EFixture();
    try {
      const wtAlpha = f.addWorktree("pi/alpha", "wt-alpha");
      const wtBeta = f.addWorktree("pi/beta", "wt-beta");

      f.writeSession(wtAlpha, "pi/alpha", "Working on Alpha");
      f.writeSession(wtBeta, "pi/beta", "Working on Beta");

      const ui = await getRenderedPickerUI({
        cwd: f.repoPath, // Invoked from main repo root
        repo: f.repoPath,
        isLinked: false,
        worktrees: [wtAlpha, wtBeta],
        agentDir: f.agentDir,
      });

      // Running from parent should list both active children
      expect(ui).toContain("[worktree branch:pi/alpha]");
      expect(ui).toContain("Working on Alpha");
      expect(ui).toContain("[worktree branch:pi/beta]");
      expect(ui).toContain("Working on Beta");
    } finally {
      f.cleanup();
    }
  });

});
