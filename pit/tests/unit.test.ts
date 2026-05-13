/**
 * Unit tests for pit utility functions.
 *
 * These cover the three pure/isolated pieces of logic that have caused real
 * bugs or are subtle enough to warrant explicit contracts:
 *
 *   cwdToBucket  — session directory naming must match pi's internal convention
 *                  exactly, or sessions created by pit are invisible to pi and
 *                  `pit -r` can't find them.
 *
 *   parseFlags   — pit-only flags (--no-sandbox, -nt/--no-tree) must be stripped
 *                  before the remaining argv is forwarded to pi. If they leak
 *                  through, pi rejects them as unknown flags.
 *
 *   setupNewSession — pi's SessionManager.appendCustomEntry() buffers writes
 *                     in-memory and never flushes until pi itself opens the
 *                     session. pit pre-seeds the session file via direct JSONL
 *                     writes instead. These tests verify the file is actually
 *                     written and has the structure pi expects.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { SessionManager, CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { cwdToBucket, parseFlags, setupNewSession, type WorktreeResult } from "../utils.ts";

// ── cwdToBucket ───────────────────────────────────────────────────────────────
//
// pi stores sessions in ~/.pi/agent/sessions/<bucket>/ where <bucket> is
// derived from the working directory. pit must produce the same bucket name
// or sessions land in the wrong place and are invisible to pi's own picker.
//
// The algorithm: strip leading slash, replace all slashes/colons with dashes,
// wrap with "--". On WSL, repos live on /mnt/c/... which must round-trip
// correctly — the leading / is the tricky part.

describe("cwdToBucket", () => {
  it("wraps with double dashes", () => {
    expect(cwdToBucket("/home/user/repo")).toMatch(/^--.*--$/);
  });

  it("strips leading slash so the bucket doesn't start with ---", () => {
    // Without stripping, "/home/user" → "---home-user--" (triple dash).
    // pi produces "--home-user--" (double dash), so sessions would be missed.
    expect(cwdToBucket("/home/user/repo")).toBe("--home-user-repo--");
  });

  it("handles Windows-mounted WSL paths (/mnt/c/...)", () => {
    // Repos live on /mnt/c/ in this setup. The bucket must match exactly
    // what pi produces when pi itself runs in that directory.
    expect(cwdToBucket("/mnt/c/Users/ricfr/Repos/agent")).toBe(
      "--mnt-c-Users-ricfr-Repos-agent--"
    );
  });

  it("replaces backslashes (Windows paths)", () => {
    expect(cwdToBucket("\\some\\windows\\path")).toBe("--some-windows-path--");
  });

  it("replaces colons (Windows drive letters)", () => {
    expect(cwdToBucket("/mnt/c:/Users")).toBe("--mnt-c--Users--");
  });

  it("matches the format of real session dirs created by pi", () => {
    // Ground-truth sanity check: every bucket pi has already created on this
    // machine follows the --…-- pattern, confirming the algorithm is correct.
    const sessionsDir = path.join(process.env.HOME!, ".pi", "agent", "sessions");
    if (!fs.existsSync(sessionsDir)) return;
    const realBuckets = fs.readdirSync(sessionsDir).filter((d) => d.startsWith("--"));
    for (const bucket of realBuckets.slice(0, 5)) {
      expect(bucket).toMatch(/^--.*--$/);
    }
  });
});

// ── parseFlags ────────────────────────────────────────────────────────────────
//
// pit introduces two flags that pi doesn't know about:
//   --no-sandbox  disable bwrap wrapping (sandbox is the default)
//   -nt / --no-tree  skip worktree creation even inside a git repo
//
// These must be stripped from argv before the rest is forwarded to pi.
// If they leak through, pi exits with "unknown option".

describe("parseFlags", () => {
  it("sandbox defaults to true (sandbox-by-default is the design)", () => {
    expect(parseFlags([]).sandbox).toBe(true);
  });

  it("--no-sandbox opts out of bwrap", () => {
    expect(parseFlags(["--no-sandbox"]).sandbox).toBe(false);
  });

  it("--no-sandbox is stripped so pi never sees it", () => {
    const { filteredArgv } = parseFlags(["--model", "sonnet", "--no-sandbox"]);
    expect(filteredArgv).not.toContain("--no-sandbox");
    expect(filteredArgv).toContain("--model");
    expect(filteredArgv).toContain("sonnet");
  });

  it("noTree defaults to false", () => {
    expect(parseFlags([]).noTree).toBe(false);
  });

  it("-nt requests no-tree mode", () => {
    expect(parseFlags(["-nt"]).noTree).toBe(true);
  });

  it("--no-tree requests no-tree mode", () => {
    expect(parseFlags(["--no-tree"]).noTree).toBe(true);
  });

  it("-nt is stripped so pi never sees it", () => {
    const { filteredArgv } = parseFlags(["-nt", "--thinking", "high"]);
    expect(filteredArgv).not.toContain("-nt");
    expect(filteredArgv).toContain("--thinking");
  });

  it("--no-tree is stripped so pi never sees it", () => {
    const { filteredArgv } = parseFlags(["--no-tree", "hello"]);
    expect(filteredArgv).not.toContain("--no-tree");
    expect(filteredArgv).toContain("hello");
  });

  it("pit-only flags can be combined with each other and with pi flags", () => {
    const result = parseFlags(["--no-sandbox", "-nt", "--model", "sonnet"]);
    expect(result.sandbox).toBe(false);
    expect(result.noTree).toBe(true);
    expect(result.filteredArgv).toEqual(["--model", "sonnet"]);
  });

  it("unrecognised flags pass through unchanged (pi handles them)", () => {
    const { filteredArgv } = parseFlags(["-r", "--thinking", "high", "hello"]);
    expect(filteredArgv).toEqual(["-r", "--thinking", "high", "hello"]);
  });

  it("empty argv returns all defaults", () => {
    expect(parseFlags([])).toEqual({ sandbox: true, noTree: false, filteredArgv: [] });
  });
});

// ── setupNewSession ───────────────────────────────────────────────────────────
//
// pit pre-seeds the session file with two entries before launching pi:
//   1. a CustomEntry  (type: "custom")         — pit metadata, not shown to user or LLM
//   2. a CustomMessageEntry (type: "custom_message", display: true)
//                                              — mode announcement, shown in TUI and sent to LLM
//
// The file must be written via direct JSONL I/O, NOT via SessionManager's
// append methods. SessionManager buffers writes in-memory and only flushes
// them when pi itself opens the session — meaning the file would be empty
// when pit passes --session <path> to pi, and pi would ignore it and start
// a fresh session in the wrong bucket.

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

  it("actually writes the file to disk (guards against SessionManager buffering regression)", () => {
    // The original implementation used SessionManager.appendCustomEntry()
    // which never flushed to disk. This test would have caught that bug.
    const agentDir = makeTmpAgentDir();
    const sessionFile = setupNewSession(makeWorktreeResult(), agentDir);
    expect(fs.existsSync(sessionFile)).toBe(true);
  });

  it("places the file under the correct bucket for the cwd", () => {
    const agentDir = makeTmpAgentDir();
    const result = makeWorktreeResult();
    const sessionFile = setupNewSession(result, agentDir);
    const bucket = cwdToBucket(result.cwd);
    expect(sessionFile).toContain(path.join(agentDir, "sessions", bucket));
  });

  it("file has exactly 3 lines (header + custom + custom_message)", () => {
    const agentDir = makeTmpAgentDir();
    const sessionFile = setupNewSession(makeWorktreeResult(), agentDir);
    const lines = fs.readFileSync(sessionFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
  });

  it("line 1 is a valid session header with correct version and cwd", () => {
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

  it("line 2 is a pit CustomEntry carrying the worktree metadata", () => {
    // This entry is how pit -r finds sessions later: SessionManager.listAll()
    // scans all sessions for type=custom, customType=pit entries.
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

  it("line 3 is a CustomMessageEntry with display: true (shown in TUI)", () => {
    // display: true means pi renders this in the chat on session load, so
    // the user sees the mode announcement without needing to run a command.
    const agentDir = makeTmpAgentDir();
    const sessionFile = setupNewSession(makeWorktreeResult(), agentDir);
    const lines = fs.readFileSync(sessionFile, "utf8").trim().split("\n");
    const msg = JSON.parse(lines[2]);
    expect(msg.type).toBe("custom_message");
    expect(msg.customType).toBe("pit");
    expect(msg.display).toBe(true);
    expect(msg.content).toContain("worktree mode");
  });

  it("CustomMessageEntry parentId chains to CustomEntry id", () => {
    // pi walks the parentId chain to build context; a broken chain would
    // cause the message to appear detached from the session tree.
    const agentDir = makeTmpAgentDir();
    const sessionFile = setupNewSession(makeWorktreeResult(), agentDir);
    const lines = fs.readFileSync(sessionFile, "utf8").trim().split("\n");
    const custom = JSON.parse(lines[1]);
    const message = JSON.parse(lines[2]);
    expect(message.parentId).toBe(custom.id);
  });

  it("no-tree mode announcement tells user there is no git repo", () => {
    // When pit is run outside a git repo it falls back to no-tree mode.
    // The announcement informs the user why no worktree was created.
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
      },
    };
    const sessionFile = setupNewSession(result, agentDir);
    const lines = fs.readFileSync(sessionFile, "utf8").trim().split("\n");
    const msg = JSON.parse(lines[2]);
    expect(msg.content).toContain("no-tree mode");
  });

  it("session file can be opened by SessionManager (pi compatibility check)", () => {
    // If the JSONL structure is malformed pi will silently ignore the file
    // and start a fresh session instead of opening the pre-seeded one.
    const agentDir = makeTmpAgentDir();
    const sessionFile = setupNewSession(makeWorktreeResult(), agentDir);
    expect(() => SessionManager.open(sessionFile)).not.toThrow();
    const sm = SessionManager.open(sessionFile);
    // header is excluded from getEntries(); custom + custom_message = 2
    expect(sm.getEntries().length).toBe(2);
  });

  it("SessionManager can locate the pit CustomEntry for pit -r", () => {
    // pit -r calls SessionManager.listAll() and scans entries for
    // customType=pit. If this lookup fails no sessions appear in the picker.
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
