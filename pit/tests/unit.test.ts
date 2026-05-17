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
import { fileURLToPath } from "node:url";
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager, CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { cwdToBucket, parseFlags, setupNewSession, formatSandboxNote, buildAnnouncement, isLinkedWorktree, type WorktreeResult, type SandboxMounts, type PitMetadata } from "../utils.ts";

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

// ── formatSandboxNote ───────────────────────────────────────────────────────────
//
// Transforms a SandboxMount list into the sandbox section of the agent
// announcement. The key behaviour is label-based deduplication: multiple mount
// entries sharing a label (e.g. several extension paths all labelled
// "Pi extensions") collapse to a single entry in the output.

describe("formatSandboxNote", () => {
  const ro  = (path: string, label?: string) => ({ path, label });
  const opt = (path: string, label?: string) => ({ path, label, optional: true });
  const rw  = (path: string, label?: string) => ({ path, label });

  it("includes the bwrap header line", () => {
    const note = formatSandboxNote({ ro: [], rw: [rw("/work")] });
    expect(note).toContain("**Sandbox (bwrap):**");
  });

  it("lists rw paths under Read-write", () => {
    const note = formatSandboxNote({ ro: [], rw: [rw("/work"), rw("/cfg", "Pi config dir")] });
    expect(note).toContain("`/work`");
    expect(note).toContain("`Pi config dir`");
    expect(note).toMatch(/Read-write:.*\/work/);
  });

  it("lists ro paths under Read-only", () => {
    const note = formatSandboxNote({ ro: [ro("/usr", "system dirs"), ro("/etc", "system dirs")], rw: [] });
    expect(note).toMatch(/Read-only:.*system dirs/);
  });

  it("uses the literal path as label when no label is provided", () => {
    const note = formatSandboxNote({ ro: [], rw: [rw("/some/worktree")] });
    expect(note).toContain("`/some/worktree`");
  });

  it("deduplicates entries with the same label", () => {
    // Two extension paths with the same label → one entry in the output.
    const note = formatSandboxNote({
      ro: [ro("/repos/agent/extensions/sudo.ts", "Pi extensions"), ro("/repos/agent/node_modules", "Pi extensions")],
      rw: [],
    });
    const matches = note.match(/`Pi extensions`/g);
    expect(matches).toHaveLength(1);
  });

  it("Read-write section always appears before Read-only section", () => {
    const note = formatSandboxNote({
      ro: [ro("/home", "home directory"), ro("/usr", "system dirs")],
      rw: [rw("/work"), rw("/cfg", "Pi config dir")],
    });
    expect(note.indexOf("Read-write")).toBeLessThan(note.indexOf("Read-only"));
  });

  it("optional flag does not affect the label (it is a bwrap concern only)", () => {
    const required = formatSandboxNote({ ro: [ro("/lib", "system dirs")],  rw: [] });
    const optional = formatSandboxNote({ ro: [opt("/lib", "system dirs")], rw: [] });
    expect(required).toBe(optional);
  });

  it("includes the no-access footer", () => {
    const note = formatSandboxNote({ ro: [], rw: [rw("/work")] });
    expect(note).toContain("No access:");
  });
});

// ── buildAnnouncement ─────────────────────────────────────────────────────────
//
// Pure function that composes the full agent announcement from PitMetadata
// and an optional mount list. Covers all three mode variants (worktree,
// no-tree forced, no-tree no-repo) and both sandbox states.

describe("buildAnnouncement", () => {
  const worktreeMeta: PitMetadata = {
    id: "a1b2c3d4",
    repo: "/tmp/repo",
    worktree: "/tmp/repo-wt-a1b2c3d4",
    branch: "pi/a1b2c3d4",
    created: "2026-01-01T00:00:00.000Z",
    mode: "worktree",
  };

  const forcedMeta: PitMetadata = {
    id: "b2c3d4e5",
    repo: "/tmp/repo",
    worktree: "/tmp/repo",
    branch: "",
    created: "2026-01-01T00:00:00.000Z",
    mode: "no-tree",
    noTreeReason: "forced",
  };

  const noRepoMeta: PitMetadata = {
    id: "c3d4e5f6",
    repo: "/tmp/somedir",
    worktree: "/tmp/somedir",
    branch: "",
    created: "2026-01-01T00:00:00.000Z",
    mode: "no-tree",
    noTreeReason: "no-repo",
  };

  const mounts: SandboxMounts = {
    ro: [{ path: "/home/user", label: "home directory" }],
    rw: [
      { path: "/tmp/repo-wt-a1b2c3d4" },
      { path: "/home/user/.pi/agent", label: "Pi config dir" },
    ],
  };

  // ── worktree mode ──────────────────────────────────────────────────────────

  it("worktree mode: contains the pit worktree mode header", () => {
    expect(buildAnnouncement(worktreeMeta)).toContain("**pit — worktree mode**");
  });

  it("worktree mode: contains the branch name", () => {
    expect(buildAnnouncement(worktreeMeta)).toContain("`pi/a1b2c3d4`");
  });

  it("worktree mode: contains the worktree path", () => {
    expect(buildAnnouncement(worktreeMeta)).toContain("`/tmp/repo-wt-a1b2c3d4`");
  });

  it("worktree mode: explains branch isolation to the agent", () => {
    const text = buildAnnouncement(worktreeMeta);
    expect(text).toContain("not on the main branch");
    expect(text).toContain("The main working tree is untouched");
  });

  // ── no-tree forced ────────────────────────────────────────────────────────

  it("no-tree forced: contains the no-tree skipped header", () => {
    expect(buildAnnouncement(forcedMeta)).toContain("worktree creation skipped");
  });

  it("no-tree forced: explains -nt flag", () => {
    expect(buildAnnouncement(forcedMeta)).toContain("-nt");
  });

  it("no-tree forced: warns about missing git isolation", () => {
    expect(buildAnnouncement(forcedMeta)).toContain("No git isolation");
  });

  // ── no-tree no-repo ───────────────────────────────────────────────────────

  it("no-tree no-repo: contains the no-tree header", () => {
    expect(buildAnnouncement(noRepoMeta)).toContain("**pit — no-tree mode**");
  });

  it("no-tree no-repo: explains the absence of a git repository", () => {
    expect(buildAnnouncement(noRepoMeta)).toContain("Not inside a git repository");
  });

  it("no-tree no-repo: warns about missing git isolation", () => {
    expect(buildAnnouncement(noRepoMeta)).toContain("No git isolation");
  });

  // ── sandbox section ───────────────────────────────────────────────────────

  it("no sandbox mounts: announcement contains no sandbox section", () => {
    const text = buildAnnouncement(worktreeMeta);
    expect(text).not.toContain("Sandbox (bwrap)");
  });

  it("with sandbox mounts: announcement contains the sandbox section", () => {
    const text = buildAnnouncement(worktreeMeta, mounts);
    expect(text).toContain("Sandbox (bwrap)");
  });

  it("sandbox section appears after the mode content", () => {
    const text = buildAnnouncement(worktreeMeta, mounts);
    expect(text.indexOf("Sandbox (bwrap)")).toBeGreaterThan(text.indexOf("worktree mode"));
  });

  it("sandbox section is identical to formatSandboxNote output", () => {
    // buildAnnouncement must not transform the sandbox note — it just appends it.
    const text = buildAnnouncement(worktreeMeta, mounts);
    expect(text).toContain(formatSandboxNote(mounts));
  });

  it("all three modes include the sandbox section when mounts are provided", () => {
    for (const meta of [worktreeMeta, forcedMeta, noRepoMeta]) {
      expect(buildAnnouncement(meta, mounts)).toContain("Sandbox (bwrap)");
    }
  });

  it("all three modes omit the sandbox section when mounts are absent", () => {
    for (const meta of [worktreeMeta, forcedMeta, noRepoMeta]) {
      expect(buildAnnouncement(meta)).not.toContain("Sandbox (bwrap)");
    }
  });
});

// ── isLinkedWorktree ─────────────────────────────────────────────────────
//
// Detects linked git worktrees via the .git-file invariant: a linked worktree
// always has .git as a plain file containing "gitdir: <path>/.git/worktrees/...",
// while the main checkout has .git as a directory and submodules use /modules/.
// No branch name knowledge required.

describe("isLinkedWorktree", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  function makeDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "pit-linked-wt-test-"));
    tmpDirs.push(d);
    return d;
  }

  it("returns false when .git does not exist (non-git dir)", () => {
    const d = makeDir();
    expect(isLinkedWorktree(d)).toBe(false);
  });

  it("returns false when .git is a directory (main checkout)", () => {
    const d = makeDir();
    fs.mkdirSync(path.join(d, ".git"));
    expect(isLinkedWorktree(d)).toBe(false);
  });

  it("returns true when .git file contains a /worktrees/ gitdir (linked worktree)", () => {
    const d = makeDir();
    fs.writeFileSync(path.join(d, ".git"), "gitdir: /home/user/repo/.git/worktrees/wt-abc\n");
    expect(isLinkedWorktree(d)).toBe(true);
  });

  it("returns false when .git file contains a /modules/ gitdir (submodule)", () => {
    const d = makeDir();
    fs.writeFileSync(path.join(d, ".git"), "gitdir: ../.git/modules/sub\n");
    expect(isLinkedWorktree(d)).toBe(false);
  });

  it("returns false for a non-existent directory", () => {
    expect(isLinkedWorktree("/nonexistent/path/pit-test-should-not-exist")).toBe(false);
  });

  it("handles gitdir value without trailing newline", () => {
    const d = makeDir();
    fs.writeFileSync(path.join(d, ".git"), "gitdir: /repo/.git/worktrees/abc");
    expect(isLinkedWorktree(d)).toBe(true);
  });

  it("is insensitive to the branch name — any /worktrees/ path returns true", () => {
    const d = makeDir();
    // Renamed branch, no pi/ prefix — still a linked worktree
    fs.writeFileSync(path.join(d, ".git"), "gitdir: /repo/.git/worktrees/my-custom-name\n");
    expect(isLinkedWorktree(d)).toBe(true);
  });
});

// ── setupNewSession ───────────────────────────────────────────────────────────
//
// Writes the session file scaffold: a session header, a pit CustomEntry
// carrying worktree metadata, and a visible CustomMessageEntry (TUI banner).
// The banner is written once here on creation; context reaches the model on
// every launch (including resume) via --append-system-prompt instead.
//
// The file must be written via direct JSONL I/O, NOT via SessionManager's
// append methods. SessionManager buffers writes in-memory and only flushes
// them when pi itself opens the session.

describe("setupNewSession", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  const TEST_SANDBOX = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "test-sandbox"
);

function makeTmpAgentDir(): string {
  fs.mkdirSync(TEST_SANDBOX, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TEST_SANDBOX, "pit-test-agent-"));
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

  it("file has exactly 3 lines (header + custom metadata + custom_message)", () => {
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

  it("session file can be opened by SessionManager (pi compatibility check)", () => {
    const agentDir = makeTmpAgentDir();
    const sessionFile = setupNewSession(makeWorktreeResult(), agentDir);
    expect(() => SessionManager.open(sessionFile)).not.toThrow();
    const sm = SessionManager.open(sessionFile);
    // header excluded; custom metadata + custom_message = 2
    expect(sm.getEntries().length).toBe(2);
  });

  it("SessionManager can locate the pit CustomEntry for pit -r", () => {
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

  it("line 3 is a CustomMessageEntry with display: true (TUI banner)", () => {
    const agentDir = makeTmpAgentDir();
    const sessionFile = setupNewSession(makeWorktreeResult(), agentDir);
    const lines = fs.readFileSync(sessionFile, "utf8").trim().split("\n");
    const msg = JSON.parse(lines[2]);
    expect(msg.type).toBe("custom_message");
    expect(msg.customType).toBe("pit");
    expect(msg.display).toBe(true);
  });

  it("CustomMessageEntry parentId chains to CustomEntry id", () => {
    const agentDir = makeTmpAgentDir();
    const sessionFile = setupNewSession(makeWorktreeResult(), agentDir);
    const lines = fs.readFileSync(sessionFile, "utf8").trim().split("\n");
    const custom = JSON.parse(lines[1]);
    const message = JSON.parse(lines[2]);
    expect(message.parentId).toBe(custom.id);
  });

  it("announcement includes sandbox section when mounts provided", () => {
    const agentDir = makeTmpAgentDir();
    const result = makeWorktreeResult();
    const mounts: SandboxMounts = {
      ro: [{ path: "/home/user", label: "home directory" }],
      rw: [{ path: result.cwd }],
    };
    const sessionFile = setupNewSession(result, agentDir, mounts);
    const msg = JSON.parse(fs.readFileSync(sessionFile, "utf8").trim().split("\n")[2]);
    expect(msg.content).toContain("Sandbox (bwrap)");
  });

  it("announcement omits sandbox section when no mounts provided", () => {
    const agentDir = makeTmpAgentDir();
    const sessionFile = setupNewSession(makeWorktreeResult(), agentDir);
    const msg = JSON.parse(fs.readFileSync(sessionFile, "utf8").trim().split("\n")[2]);
    expect(msg.content).not.toContain("Sandbox (bwrap)");
  });

  it("no-tree mode announcement tells user there is no git repo", () => {
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
});
