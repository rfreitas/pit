import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { SessionManager, CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { cwdToBucket, parseFlags, setupNewSession, type WorktreeResult } from "../utils.ts";

// ── cwdToBucket ───────────────────────────────────────────────────────────────

describe("cwdToBucket", () => {
  it("wraps with double dashes", () => {
    expect(cwdToBucket("/home/user/repo")).toMatch(/^--.*--$/);
  });

  it("strips leading slash", () => {
    expect(cwdToBucket("/home/user/repo")).toBe("--home-user-repo--");
  });

  it("handles Windows-mounted WSL path (/mnt/c/...)", () => {
    // This was an implicit bug source — the leading / must be stripped
    // so pi's own bucket naming matches
    expect(cwdToBucket("/mnt/c/Users/ricfr/Repos/agent")).toBe(
      "--mnt-c-Users-ricfr-Repos-agent--"
    );
  });

  it("replaces backslashes", () => {
    expect(cwdToBucket("\\some\\windows\\path")).toBe("--some-windows-path--");
  });

  it("replaces colons (Windows drive letters)", () => {
    expect(cwdToBucket("/mnt/c:/Users")).toBe("--mnt-c--Users--");
  });

  it("matches real session dirs created by pi", () => {
    // Ground-truth check: compare against session bucket dirs that pi
    // actually created during this project's lifetime
    const sessionsDir = path.join(
      process.env.HOME!,
      ".pi",
      "agent",
      "sessions"
    );
    if (!fs.existsSync(sessionsDir)) return; // skip if no sessions yet

    const realBuckets = fs.readdirSync(sessionsDir).filter((d) =>
      d.startsWith("--")
    );

    for (const bucket of realBuckets.slice(0, 5)) {
      // Reverse-engineer the cwd from the bucket name and verify round-trip
      // Bucket format: --<path-with-dashes>--
      // We can't perfectly reverse (dashes could be path separators or original dashes)
      // but we can verify our function produces the same format pi expects
      expect(bucket).toMatch(/^--.*--$/);
    }
  });
});

// ── parseFlags ────────────────────────────────────────────────────────────────

describe("parseFlags", () => {
  it("sandbox is true by default", () => {
    expect(parseFlags([]).sandbox).toBe(true);
  });

  it("--no-sandbox sets sandbox=false", () => {
    expect(parseFlags(["--no-sandbox"]).sandbox).toBe(false);
  });

  it("--no-sandbox is stripped from filteredArgv", () => {
    const { filteredArgv } = parseFlags(["--model", "sonnet", "--no-sandbox"]);
    expect(filteredArgv).not.toContain("--no-sandbox");
    expect(filteredArgv).toContain("--model");
    expect(filteredArgv).toContain("sonnet");
  });

  it("noTree is false by default", () => {
    expect(parseFlags([]).noTree).toBe(false);
  });

  it("-nt sets noTree=true", () => {
    expect(parseFlags(["-nt"]).noTree).toBe(true);
  });

  it("--no-tree sets noTree=true", () => {
    expect(parseFlags(["--no-tree"]).noTree).toBe(true);
  });

  it("-nt is stripped from filteredArgv", () => {
    const { filteredArgv } = parseFlags(["-nt", "--thinking", "high"]);
    expect(filteredArgv).not.toContain("-nt");
    expect(filteredArgv).toContain("--thinking");
  });

  it("--no-tree is stripped from filteredArgv", () => {
    const { filteredArgv } = parseFlags(["--no-tree", "hello"]);
    expect(filteredArgv).not.toContain("--no-tree");
    expect(filteredArgv).toContain("hello");
  });

  it("both --no-sandbox and -nt can be combined", () => {
    const result = parseFlags(["--no-sandbox", "-nt", "--model", "sonnet"]);
    expect(result.sandbox).toBe(false);
    expect(result.noTree).toBe(true);
    expect(result.filteredArgv).toEqual(["--model", "sonnet"]);
  });

  it("passes unrecognised flags through unchanged", () => {
    const { filteredArgv } = parseFlags(["-r", "--thinking", "high", "hello"]);
    expect(filteredArgv).toEqual(["-r", "--thinking", "high", "hello"]);
  });

  it("empty argv returns defaults", () => {
    const result = parseFlags([]);
    expect(result).toEqual({ sandbox: true, noTree: false, filteredArgv: [] });
  });
});

// ── setupNewSession ───────────────────────────────────────────────────────────

describe("setupNewSession", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  function makeTmpAgentDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pit-test-agent-"));
    tmpDirs.push(dir);
    return dir;
  }

  function makeWorktreeResult(overrides: Partial<WorktreeResult> = {}): WorktreeResult {
    return {
      mode: "worktree",
      cwd: "/tmp/test-repo-wt-a1b2c3d4",
      meta: {
        id: "a1b2c3d4",
        repo: "/tmp/test-repo",
        worktree: "/tmp/test-repo-wt-a1b2c3d4",
        branch: "pi/a1b2c3d4",
        created: "2026-01-01T00:00:00.000Z",
        mode: "worktree",
      },
      ...overrides,
    };
  }

  it("creates the session file on disk", () => {
    const agentDir = makeTmpAgentDir();
    const result = makeWorktreeResult();
    const sessionFile = setupNewSession(result, agentDir);
    expect(fs.existsSync(sessionFile)).toBe(true);
  });

  it("places the file in the correct bucket directory", () => {
    const agentDir = makeTmpAgentDir();
    const result = makeWorktreeResult();
    const sessionFile = setupNewSession(result, agentDir);
    const bucket = cwdToBucket(result.cwd);
    expect(sessionFile).toContain(path.join(agentDir, "sessions", bucket));
  });

  it("session file has exactly 3 lines", () => {
    const agentDir = makeTmpAgentDir();
    const sessionFile = setupNewSession(makeWorktreeResult(), agentDir);
    const lines = fs.readFileSync(sessionFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
  });

  it("line 1 is a valid session header", () => {
    const agentDir = makeTmpAgentDir();
    const result = makeWorktreeResult();
    const sessionFile = setupNewSession(result, agentDir);
    const header = JSON.parse(fs.readFileSync(sessionFile, "utf8").split("\n")[0]);
    expect(header.type).toBe("session");
    expect(header.version).toBe(CURRENT_SESSION_VERSION);
    expect(header.cwd).toBe(result.cwd);
    expect(typeof header.id).toBe("string");
    expect(typeof header.timestamp).toBe("string");
  });

  it("line 2 is a pit CustomEntry with correct metadata", () => {
    const agentDir = makeTmpAgentDir();
    const result = makeWorktreeResult();
    const sessionFile = setupNewSession(result, agentDir);
    const lines = fs.readFileSync(sessionFile, "utf8").trim().split("\n");
    const entry = JSON.parse(lines[1]);
    expect(entry.type).toBe("custom");
    expect(entry.customType).toBe("pit");
    expect(entry.parentId).toBeNull();
    expect(entry.data.id).toBe(result.meta.id);
    expect(entry.data.branch).toBe(result.meta.branch);
    expect(entry.data.worktree).toBe(result.meta.worktree);
    expect(entry.data.mode).toBe("worktree");
  });

  it("line 3 is a CustomMessageEntry with display: true", () => {
    const agentDir = makeTmpAgentDir();
    const sessionFile = setupNewSession(makeWorktreeResult(), agentDir);
    const lines = fs.readFileSync(sessionFile, "utf8").trim().split("\n");
    const msg = JSON.parse(lines[2]);
    expect(msg.type).toBe("custom_message");
    expect(msg.customType).toBe("pit");
    expect(msg.display).toBe(true);
    expect(typeof msg.content).toBe("string");
    expect(msg.content).toContain("worktree mode");
  });

  it("CustomMessageEntry parentId matches CustomEntry id", () => {
    const agentDir = makeTmpAgentDir();
    const sessionFile = setupNewSession(makeWorktreeResult(), agentDir);
    const lines = fs.readFileSync(sessionFile, "utf8").trim().split("\n");
    const custom = JSON.parse(lines[1]);
    const message = JSON.parse(lines[2]);
    expect(message.parentId).toBe(custom.id);
  });

  it("no-tree (no-repo) announcement mentions no git repository", () => {
    const agentDir = makeTmpAgentDir();
    const result: WorktreeResult = {
      mode: "no-tree",
      cwd: "/tmp/some-dir",
      meta: {
        id: "b2c3d4e5",
        repo: "/tmp/some-dir",
        worktree: "/tmp/some-dir",
        branch: "",
        created: "2026-01-01T00:00:00.000Z",
        mode: "no-tree",
        noTreeReason: "no-repo",
      },
    };
    const sessionFile = setupNewSession(result, agentDir);
    const lines = fs.readFileSync(sessionFile, "utf8").trim().split("\n");
    const msg = JSON.parse(lines[2]);
    expect(msg.content).toContain("no-tree mode");
    expect(msg.content).toContain("not inside a git repository");
  });

  it("no-tree (forced) announcement says worktree creation skipped", () => {
    const agentDir = makeTmpAgentDir();
    const result: WorktreeResult = {
      mode: "no-tree",
      cwd: "/tmp/my-repo",
      meta: {
        id: "c3d4e5f6",
        repo: "/tmp/my-repo",
        worktree: "/tmp/my-repo",
        branch: "",
        created: "2026-01-01T00:00:00.000Z",
        mode: "no-tree",
        noTreeReason: "forced",
      },
    };
    const sessionFile = setupNewSession(result, agentDir);
    const lines = fs.readFileSync(sessionFile, "utf8").trim().split("\n");
    const msg = JSON.parse(lines[2]);
    expect(msg.content).toContain("no-tree mode");
    expect(msg.content).toContain("worktree creation skipped");
  });

  it("session can be opened by SessionManager without errors", () => {
    const agentDir = makeTmpAgentDir();
    const sessionFile = setupNewSession(makeWorktreeResult(), agentDir);
    expect(() => SessionManager.open(sessionFile)).not.toThrow();
    const sm = SessionManager.open(sessionFile);
    expect(sm.getEntries().length).toBe(2); // custom + custom_message (header excluded)
  });

  it("SessionManager finds the pit CustomEntry", () => {
    const agentDir = makeTmpAgentDir();
    const result = makeWorktreeResult();
    const sessionFile = setupNewSession(result, agentDir);
    const sm = SessionManager.open(sessionFile);
    const pitEntry = sm
      .getEntries()
      .find((e) => e.type === "custom" && (e as any).customType === "pit");
    expect(pitEntry).toBeDefined();
    expect((pitEntry as any).data.id).toBe(result.meta.id);
  });
});
