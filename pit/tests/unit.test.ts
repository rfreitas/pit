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
import { execFileSync } from "node:child_process";
import { SessionManager, CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { cwdToBucket, parseFlags, setupNewSession, formatSandboxNote, buildAnnouncement, isLinkedWorktree, resolveMainRepo, readWorktreeBranch, readPitConfig, applyDenylist, writeFilteredSettings, resolveUnversionedDirs, type WorktreeResult, type SandboxMounts, type OverlayMount, type PitMetadata } from "../utils.ts";
import { buildNoTreeMeta, buildWorktreeMeta, buildSandboxMountSpec, buildSessionLines, systemPromptArgs } from "../pure.ts";

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

  // ── overlay section ────────────────────────────────────────────────────────

  const ov = (src: string, dest: string, label?: string): OverlayMount => ({ src, dest, label });

  it("no overlay section when overlay is absent", () => {
    const note = formatSandboxNote({ ro: [], rw: [rw("/work")] });
    expect(note).not.toContain("Ephemeral overlay");
  });

  it("no overlay section when overlay is empty array", () => {
    const note = formatSandboxNote({ ro: [], rw: [rw("/work")], overlay: [] });
    expect(note).not.toContain("Ephemeral overlay");
  });

  it("includes ephemeral overlay section when overlay mounts present", () => {
    const note = formatSandboxNote({
      ro: [], rw: [rw("/work")],
      overlay: [ov("/parent/node_modules", "/work/node_modules", "node_modules")],
    });
    expect(note).toContain("Ephemeral overlay");
    expect(note).toContain("`node_modules`");
  });

  it("overlay section falls back to dest path when no label", () => {
    const note = formatSandboxNote({
      ro: [], rw: [rw("/work")],
      overlay: [ov("/parent/node_modules", "/work/node_modules")],
    });
    expect(note).toContain("`/work/node_modules`");
  });

  it("overlay section lists multiple dirs", () => {
    const note = formatSandboxNote({
      ro: [], rw: [rw("/work")],
      overlay: [
        ov("/parent/node_modules", "/work/node_modules", "node_modules"),
        ov("/parent/dist",         "/work/dist",         "dist"),
      ],
    });
    expect(note).toContain("`node_modules`");
    expect(note).toContain("`dist`");
  });

  it("deduplicates overlay entries that share a label", () => {
    // Two nested node_modules dirs with the same label should collapse to one entry,
    // matching the dedup behaviour of ro/rw entries.
    const note = formatSandboxNote({
      ro: [], rw: [],
      overlay: [
        ov("/parent/a/node_modules", "/wt/a/node_modules", "node_modules"),
        ov("/parent/b/node_modules", "/wt/b/node_modules", "node_modules"),
      ],
    });
    const matches = note.match(/`node_modules`/g);
    expect(matches).toHaveLength(1);
  });
});

// ── resolveMainRepo ────────────────────────────────────────────────────────
//
// Resolves the parent repo path from a linked worktree's .git file.
// This gates whether overlay mounts are set up at all: null → no overlays.

describe("resolveMainRepo", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  function makeTmpDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "pit-parent-repo-test-"));
    tmpDirs.push(d);
    return d;
  }

  it("returns null for a non-existent directory", () => {
    expect(resolveMainRepo("/nonexistent/path/pit-test-should-not-exist")).toBeNull();
  });

  it("returns null when there is no .git entry (non-git dir)", () => {
    const d = makeTmpDir();
    expect(resolveMainRepo(d)).toBeNull();
  });

  it("returns null when .git is a directory (main checkout)", () => {
    const d = makeTmpDir();
    fs.mkdirSync(path.join(d, ".git"));
    expect(resolveMainRepo(d)).toBeNull();
  });

  it("returns null for a submodule (.git file with /modules/ not /worktrees/)", () => {
    const d = makeTmpDir();
    fs.writeFileSync(path.join(d, ".git"), "gitdir: ../.git/modules/sub\n");
    expect(resolveMainRepo(d)).toBeNull();
  });

  it("returns the parent repo root for a linked worktree", () => {
    const parentRepo = makeTmpDir();
    const worktreeDir = path.join(parentRepo, ".git", "worktrees", "wt-abc");
    fs.mkdirSync(worktreeDir, { recursive: true });
    const wt = makeTmpDir();
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${worktreeDir}\n`);
    expect(resolveMainRepo(wt)).toBe(parentRepo);
  });

  it("works regardless of the worktree name in the gitdir path", () => {
    const parentRepo = makeTmpDir();
    const worktreeDir = path.join(parentRepo, ".git", "worktrees", "feature-my-branch");
    fs.mkdirSync(worktreeDir, { recursive: true });
    const wt = makeTmpDir();
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${worktreeDir}\n`);
    expect(resolveMainRepo(wt)).toBe(parentRepo);
  });

  it("handles gitdir without trailing newline", () => {
    const parentRepo = makeTmpDir();
    const worktreeDir = path.join(parentRepo, ".git", "worktrees", "wt-x");
    fs.mkdirSync(worktreeDir, { recursive: true });
    const wt = makeTmpDir();
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${worktreeDir}`);
    expect(resolveMainRepo(wt)).toBe(parentRepo);
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

// ── resolveMainRepo ──────────────────────────────────────────────────────────
//
// Resolves the main repo path from a linked worktree's .git pointer.
// Used by the session picker when pit -r is invoked from inside a worktree,
// where gitRepoRoot() returns the worktree dir rather than the main repo.

describe("resolveMainRepo", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  function makeDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "pit-main-repo-test-"));
    tmpDirs.push(d);
    return d;
  }

  it("resolves the main repo from a standard linked worktree .git file", () => {
    const d = makeDir();
    const mainRepo = "/home/user/repo";
    fs.writeFileSync(path.join(d, ".git"), `gitdir: ${mainRepo}/.git/worktrees/wt-abc
`);
    expect(resolveMainRepo(d)).toBe(mainRepo);
  });

  it("returns null when .git is a directory (main checkout)", () => {
    const d = makeDir();
    fs.mkdirSync(path.join(d, ".git"));
    expect(resolveMainRepo(d)).toBeNull();
  });

  it("returns null when .git file is a submodule", () => {
    const d = makeDir();
    fs.writeFileSync(path.join(d, ".git"), "gitdir: ../.git/modules/sub\n");
    expect(resolveMainRepo(d)).toBeNull();
  });

  it("returns null for a non-existent directory", () => {
    expect(resolveMainRepo("/nonexistent/pit-test-should-not-exist")).toBeNull();
  });

  it("handles absolute gitdir paths without trailing newline", () => {
    const d = makeDir();
    fs.writeFileSync(path.join(d, ".git"), "gitdir: /absolute/repo/.git/worktrees/wt-xyz");
    expect(resolveMainRepo(d)).toBe("/absolute/repo");
  });
});

// ── readWorktreeBranch ───────────────────────────────────────────────────
//
// Reads the current branch from a linked worktree's .git file without running
// git. Used to label sessions in the picker. Returns null for main checkouts,
// submodules, detached HEAD, or deleted worktrees.

describe("readWorktreeBranch", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  // Reuse the same temp dir helper as isLinkedWorktree tests
  function makeDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "pit-wt-branch-test-"));
    tmpDirs.push(d);
    return d;
  }

  function makeGitdir(d: string, branch: string): string {
    // Path must contain /.git/worktrees/ to pass readWorktreeBranch's guard.
    const gitdir = path.join(d + "-repo", ".git", "worktrees", "wt");
    fs.mkdirSync(gitdir, { recursive: true });
    fs.writeFileSync(path.join(gitdir, "HEAD"), `ref: refs/heads/${branch}\n`);
    tmpDirs.push(d + "-repo");
    return gitdir;
  }

  it("returns null for a directory with no .git", () => {
    const d = makeDir();
    expect(readWorktreeBranch(d)).toBeNull();
  });

  it("returns null when .git is a directory (main checkout)", () => {
    const d = makeDir();
    fs.mkdirSync(path.join(d, ".git"));
    expect(readWorktreeBranch(d)).toBeNull();
  });

  it("returns null for a submodule (.git file with /modules/ path)", () => {
    const d = makeDir();
    fs.writeFileSync(path.join(d, ".git"), "gitdir: ../.git/modules/sub\n");
    expect(readWorktreeBranch(d)).toBeNull();
  });

  it("returns the branch name for a linked worktree", () => {
    const d = makeDir();
    const gitdir = makeGitdir(d, "pi/abc1234");
    fs.writeFileSync(path.join(d, ".git"), `gitdir: ${gitdir}\n`);
    expect(readWorktreeBranch(d)).toBe("pi/abc1234");
  });

  it("returns the branch name for non-pit branch names", () => {
    const d = makeDir();
    const gitdir = makeGitdir(d, "feature/my-renamed-branch");
    fs.writeFileSync(path.join(d, ".git"), `gitdir: ${gitdir}\n`);
    expect(readWorktreeBranch(d)).toBe("feature/my-renamed-branch");
  });

  it("returns null for detached HEAD", () => {
    const d = makeDir();
    const gitdir = path.join(d + "-repo", ".git", "worktrees", "wt");
    fs.mkdirSync(gitdir, { recursive: true });
    fs.writeFileSync(path.join(gitdir, "HEAD"), "abc1234def5678\n"); // detached
    fs.writeFileSync(path.join(d, ".git"), `gitdir: ${gitdir}\n`);
    tmpDirs.push(d + "-repo");
    expect(readWorktreeBranch(d)).toBeNull();
  });

  it("returns null when the worktree directory does not exist", () => {
    expect(readWorktreeBranch("/nonexistent/path/pit-test-wt")).toBeNull();
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

// ── resolveUnversionedDirs ────────────────────────────────────────────────────────
//
// Discovers all unversioned directories in a git repo: both untracked (new,
// not yet committed) and ignored (node_modules, dist, etc.). Uses `git ls-files
// --directory` so git recurses into tracked dirs to find nested unversioned
// ones (e.g. packages/foo/node_modules) while reporting each unversioned dir
// as a unit without descending into it.

describe("resolveUnversionedDirs", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  function makeTmpDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "pit-unversioned-test-"));
    tmpDirs.push(d);
    return d;
  }

  /** Create a minimal git repo with one committed file, return its path. */
  function makeGitRepo(): string {
    const repo = makeTmpDir();
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-C", repo, "config", "user.email", "test@pit.test"], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "config", "user.name", "pit test"], { stdio: "ignore" });
    fs.writeFileSync(path.join(repo, ".gitkeep"), "");
    execFileSync("git", ["-C", repo, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "commit", "-m", "init"], { stdio: "ignore" });
    return repo;
  }

  it("returns empty array for a non-git directory", () => {
    const dir = makeTmpDir();
    expect(resolveUnversionedDirs(dir)).toEqual([]);
  });

  it("returns empty array for a non-existent path", () => {
    expect(resolveUnversionedDirs("/nonexistent/path/pit-test-unversioned")).toEqual([]);
  });

  it("returns empty array when no untracked or ignored dirs exist", () => {
    const repo = makeGitRepo();
    expect(resolveUnversionedDirs(repo)).toEqual([]);
  });

  it("does not return untracked files — only directories", () => {
    // git ls-files marks dirs with a trailing slash; files have none.
    // resolveUnversionedDirs must filter to dirs only so callers don't
    // accidentally try to --tmp-overlay a regular file.
    const repo = makeGitRepo();
    fs.writeFileSync(path.join(repo, "untracked-file.txt"), "hello");
    fs.mkdirSync(path.join(repo, "untracked-dir"));
    const result = resolveUnversionedDirs(repo);
    expect(result).toContain("untracked-dir");
    expect(result).not.toContain("untracked-file.txt");
  });

  it("does not return ignored files listed in .gitignore — only ignored dirs", () => {
    const repo = makeGitRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), "*.log\nnode_modules/\n");
    fs.writeFileSync(path.join(repo, "debug.log"), "log content"); // ignored file
    fs.mkdirSync(path.join(repo, "node_modules"));
    const result = resolveUnversionedDirs(repo);
    expect(result).toContain("node_modules");
    expect(result).not.toContain("debug.log");
  });

  it("returns an untracked directory (no .gitignore needed)", () => {
    const repo = makeGitRepo();
    fs.mkdirSync(path.join(repo, "new-dir"));
    const result = resolveUnversionedDirs(repo);
    expect(result).toContain("new-dir");
  });

  it("returns an ignored directory listed in .gitignore", () => {
    const repo = makeGitRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
    fs.mkdirSync(path.join(repo, "node_modules"));
    const result = resolveUnversionedDirs(repo);
    expect(result).toContain("node_modules");
  });

  it("does not return tracked directories", () => {
    const repo = makeGitRepo();
    // Create a tracked subdir
    fs.mkdirSync(path.join(repo, "src"));
    fs.writeFileSync(path.join(repo, "src", "index.ts"), "");
    execFileSync("git", ["-C", repo, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "commit", "-m", "add src"], { stdio: "ignore" });
    const result = resolveUnversionedDirs(repo);
    expect(result).not.toContain("src");
  });

  it("strips trailing slashes from git output", () => {
    const repo = makeGitRepo();
    fs.mkdirSync(path.join(repo, "some-dir"));
    const result = resolveUnversionedDirs(repo);
    expect(result.every((r) => !r.endsWith("/"))).toBe(true);
  });

  it("deduplicates when git would otherwise double-report", () => {
    // Both commands run against the same repo; an untracked (non-ignored) dir
    // should appear exactly once even if somehow reported by both.
    const repo = makeGitRepo();
    fs.mkdirSync(path.join(repo, "build"));
    const result = resolveUnversionedDirs(repo);
    const count = result.filter((r) => r === "build").length;
    expect(count).toBe(1);
  });

  it("finds nested unversioned dirs inside tracked directories", () => {
    // packages/ is tracked; packages/foo/node_modules is ignored.
    // git recurses into packages/ and reports packages/foo/node_modules as a unit.
    const repo = makeGitRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
    fs.mkdirSync(path.join(repo, "packages", "foo"), { recursive: true });
    fs.writeFileSync(path.join(repo, "packages", "foo", "package.json"), "{}");
    execFileSync("git", ["-C", repo, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "commit", "-m", "add packages"], { stdio: "ignore" });
    // Now create the ignored nested dir
    fs.mkdirSync(path.join(repo, "packages", "foo", "node_modules"));
    const result = resolveUnversionedDirs(repo);
    expect(result).toContain("packages/foo/node_modules");
    // The tracked packages/ dir itself must NOT appear
    expect(result).not.toContain("packages");
  });

  it("reports multiple unversioned dirs at different depths", () => {
    const repo = makeGitRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\ndist/\n");
    // Root-level ignored
    fs.mkdirSync(path.join(repo, "node_modules"));
    fs.mkdirSync(path.join(repo, "dist"));
    // Nested inside tracked dir
    fs.mkdirSync(path.join(repo, "packages", "bar"), { recursive: true });
    fs.writeFileSync(path.join(repo, "packages", "bar", "index.ts"), "");
    execFileSync("git", ["-C", repo, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "commit", "-m", "add packages"], { stdio: "ignore" });
    fs.mkdirSync(path.join(repo, "packages", "bar", "node_modules"));
    const result = resolveUnversionedDirs(repo);
    expect(result).toContain("node_modules");
    expect(result).toContain("dist");
    expect(result).toContain("packages/bar/node_modules");
  });
});

// ── applyDenylist ──────────────────────────────────────────────────────────────
//
// Pure function: filters the packages array in a settings object by removing
// any entry present in the denylist. Must not mutate the input and must
// preserve all other settings keys untouched.

describe("applyDenylist", () => {
  const settings = {
    defaultModel: "claude-sonnet",
    packages: [
      "npm:@casualjim/pi-heimdall",
      "npm:@spences10/pi-confirm-destructive",
      "npm:@jerryan/pi-sanity",
      "npm:pi-agent-browser-native",
    ],
  };

  it("removes denied packages", () => {
    const result = applyDenylist(settings, ["npm:@casualjim/pi-heimdall"]);
    expect(result.packages).not.toContain("npm:@casualjim/pi-heimdall");
  });

  it("keeps allowed packages", () => {
    const result = applyDenylist(settings, ["npm:@casualjim/pi-heimdall"]);
    expect(result.packages).toContain("npm:pi-agent-browser-native");
  });

  it("removes all packages in the denylist in one pass", () => {
    const result = applyDenylist(settings, [
      "npm:@casualjim/pi-heimdall",
      "npm:@spences10/pi-confirm-destructive",
    ]);
    expect(result.packages).toHaveLength(2);
    expect(result.packages).not.toContain("npm:@casualjim/pi-heimdall");
    expect(result.packages).not.toContain("npm:@spences10/pi-confirm-destructive");
  });

  it("empty denylist returns settings unchanged", () => {
    const result = applyDenylist(settings, []);
    expect(result.packages).toEqual(settings.packages);
  });

  it("denylist entry not in packages is silently ignored", () => {
    const result = applyDenylist(settings, ["npm:@nobody/does-not-exist"]);
    expect(result.packages).toEqual(settings.packages);
  });

  it("missing packages key is treated as empty array", () => {
    const result = applyDenylist({ defaultModel: "sonnet" }, ["npm:@casualjim/pi-heimdall"]);
    expect(result.packages).toEqual([]);
  });

  it("does not mutate the original settings object", () => {
    const original = [...settings.packages];
    applyDenylist(settings, ["npm:@casualjim/pi-heimdall"]);
    expect(settings.packages).toEqual(original);
  });

  it("preserves all non-packages keys", () => {
    const result = applyDenylist(settings, ["npm:@casualjim/pi-heimdall"]);
    expect(result.defaultModel).toBe("claude-sonnet");
  });
});

// ── readPitConfig ─────────────────────────────────────────────────────────────
//
// Reads <pitDir>/config.json and returns the parsed object. Must return an
// empty object (not throw) for absent or malformed files.

describe("readPitConfig", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  function makePitDir(): string {
    const d = fs.mkdtempSync(path.join(TEST_SANDBOX, "pit-config-test-"));
    tmpDirs.push(d);
    return d;
  }

  it("returns empty object when config.json does not exist", () => {
    const pitDir = makePitDir();
    expect(readPitConfig(pitDir)).toEqual({});
  });

  it("parses denyPackages from config.json", () => {
    const pitDir = makePitDir();
    fs.writeFileSync(
      path.join(pitDir, "config.json"),
      JSON.stringify({ denyPackages: ["npm:@casualjim/pi-heimdall"] })
    );
    expect(readPitConfig(pitDir).denyPackages).toEqual(["npm:@casualjim/pi-heimdall"]);
  });

  it("returns empty object for malformed JSON (does not throw)", () => {
    const pitDir = makePitDir();
    fs.writeFileSync(path.join(pitDir, "config.json"), "{ invalid json }");
    expect(readPitConfig(pitDir)).toEqual({});
  });

  it("returns empty object when denyPackages is absent from valid JSON", () => {
    const pitDir = makePitDir();
    fs.writeFileSync(path.join(pitDir, "config.json"), JSON.stringify({}));
    expect(readPitConfig(pitDir).denyPackages).toBeUndefined();
  });
});

// ── writeFilteredSettings ────────────────────────────────────────────────────────
//
// Reads ~/.pi/agent/settings.json, applies the denylist, and writes the
// filtered result to the host-side bound path. This is the file pit-escape
// refreshes on /reload and bwrap bind-mounts as /tmp/pit-agent/settings.json.

describe("writeFilteredSettings", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  function makeDir(): string {
    const d = fs.mkdtempSync(path.join(TEST_SANDBOX, "pit-settings-test-"));
    tmpDirs.push(d);
    return d;
  }

  const rawSettings = {
    defaultModel: "claude-sonnet",
    packages: [
      "npm:@casualjim/pi-heimdall",
      "npm:@spences10/pi-confirm-destructive",
      "npm:pi-agent-browser-native",
    ],
  };

  it("writes a file at the given path", () => {
    const agentDir = makeDir();
    const outDir = makeDir();
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(rawSettings));
    const outPath = path.join(outDir, "settings.json");
    writeFilteredSettings(agentDir, {}, outPath);
    expect(fs.existsSync(outPath)).toBe(true);
  });

  it("output is valid JSON", () => {
    const agentDir = makeDir();
    const outDir = makeDir();
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(rawSettings));
    const outPath = path.join(outDir, "settings.json");
    writeFilteredSettings(agentDir, {}, outPath);
    expect(() => JSON.parse(fs.readFileSync(outPath, "utf8"))).not.toThrow();
  });

  it("removes denied packages from the output", () => {
    const agentDir = makeDir();
    const outDir = makeDir();
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(rawSettings));
    const outPath = path.join(outDir, "settings.json");
    writeFilteredSettings(agentDir, { denyPackages: ["npm:@casualjim/pi-heimdall"] }, outPath);
    const result = JSON.parse(fs.readFileSync(outPath, "utf8"));
    expect(result.packages).not.toContain("npm:@casualjim/pi-heimdall");
    expect(result.packages).toContain("npm:pi-agent-browser-native");
  });

  it("with empty denylist, output packages match input exactly", () => {
    const agentDir = makeDir();
    const outDir = makeDir();
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(rawSettings));
    const outPath = path.join(outDir, "settings.json");
    writeFilteredSettings(agentDir, {}, outPath);
    const result = JSON.parse(fs.readFileSync(outPath, "utf8"));
    expect(result.packages).toEqual(rawSettings.packages);
  });

  it("creates parent directories if they don't exist", () => {
    const agentDir = makeDir();
    const outDir = makeDir();
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(rawSettings));
    const outPath = path.join(outDir, "nested", "deep", "settings.json");
    writeFilteredSettings(agentDir, {}, outPath);
    expect(fs.existsSync(outPath)).toBe(true);
  });

  it("preserves non-packages keys in the output", () => {
    const agentDir = makeDir();
    const outDir = makeDir();
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(rawSettings));
    const outPath = path.join(outDir, "settings.json");
    writeFilteredSettings(agentDir, { denyPackages: ["npm:@casualjim/pi-heimdall"] }, outPath);
    const result = JSON.parse(fs.readFileSync(outPath, "utf8"));
    expect(result.defaultModel).toBe("claude-sonnet");
  });

  it("absent settings.json produces an empty object (no throw)", () => {
    const agentDir = makeDir(); // no settings.json written
    const outDir = makeDir();
    const outPath = path.join(outDir, "settings.json");
    expect(() => writeFilteredSettings(agentDir, {}, outPath)).not.toThrow();
    const result = JSON.parse(fs.readFileSync(outPath, "utf8"));
    expect(result).toEqual({});
  });
});

// ── buildNoTreeMeta ──────────────────────────────────────────────────────────
//
// Pure metadata builder for no-tree sessions. Callers supply id + created so
// the IO boundary (genId, new Date) stays in worktreeCheck / prepareLinkedWorktreeSession.

describe("buildNoTreeMeta", () => {
  it("sets mode to 'no-tree'", () => {
    expect(buildNoTreeMeta("/cwd", "/repo", "no-repo", "abc", "2026-01-01T00:00:00.000Z").mode).toBe("no-tree");
  });

  it("sets noTreeReason correctly for all variants", () => {
    expect(buildNoTreeMeta("/cwd", "/repo", "no-repo",         "a", "t").noTreeReason).toBe("no-repo");
    expect(buildNoTreeMeta("/cwd", "/repo", "forced",          "a", "t").noTreeReason).toBe("forced");
    expect(buildNoTreeMeta("/cwd", "/repo", "linked-worktree", "a", "t").noTreeReason).toBe("linked-worktree");
  });

  it("uses the supplied id and created timestamp", () => {
    const meta = buildNoTreeMeta("/cwd", "/repo", "no-repo", "deadbeef", "2026-06-01T12:00:00.000Z");
    expect(meta.id).toBe("deadbeef");
    expect(meta.created).toBe("2026-06-01T12:00:00.000Z");
  });

  it("sets worktree and repo to the provided paths", () => {
    const meta = buildNoTreeMeta("/my/cwd", "/my/repo", "forced", "id", "ts");
    expect(meta.worktree).toBe("/my/cwd");
    expect(meta.repo).toBe("/my/repo");
  });

  it("always has an empty branch", () => {
    expect(buildNoTreeMeta("/cwd", "/repo", "no-repo", "id", "ts").branch).toBe("");
  });
});

// ── buildWorktreeMeta ─────────────────────────────────────────────────────────
//
// Pure metadata builder for worktree sessions. Derives worktree path and branch
// from repo + id. Callers supply id + created.

describe("buildWorktreeMeta", () => {
  it("sets mode to 'worktree'", () => {
    expect(buildWorktreeMeta("/repo", "abc12345", "ts").mode).toBe("worktree");
  });

  it("derives branch as pi/<id>", () => {
    expect(buildWorktreeMeta("/repo", "abc12345", "ts").branch).toBe("pi/abc12345");
  });

  it("derives worktree path as <parent>/<basename>-wt-<id>", () => {
    const meta = buildWorktreeMeta("/home/user/repo", "abc12345", "ts");
    expect(meta.worktree).toBe("/home/user/repo-wt-abc12345");
  });

  it("uses the supplied id and created timestamp", () => {
    const meta = buildWorktreeMeta("/repo", "deadbeef", "2026-06-01T00:00:00.000Z");
    expect(meta.id).toBe("deadbeef");
    expect(meta.created).toBe("2026-06-01T00:00:00.000Z");
  });

  it("sets repo to the provided path", () => {
    expect(buildWorktreeMeta("/my/repo", "id", "ts").repo).toBe("/my/repo");
  });
});

// ── buildSessionLines ─────────────────────────────────────────────────────────
//
// Pure content builder for session JSONL files. setupNewSession calls this after
// generating sessionId + isoTs at the IO boundary.

describe("buildSessionLines", () => {
  const result: WorktreeResult = {
    mode: "worktree",
    cwd: "/tmp/repo-wt-abc",
    meta: {
      id: "abc12345",
      repo: "/tmp/repo",
      worktree: "/tmp/repo-wt-abc",
      branch: "pi/abc12345",
      created: "2026-01-01T00:00:00.000Z",
      mode: "worktree",
    },
  };

  it("returns exactly 3 newline-terminated lines", () => {
    const lines = buildSessionLines(result, "uuid-1", "2026-01-01T00:00:00.000Z").trim().split("\n");
    expect(lines).toHaveLength(3);
  });

  it("line 1 is a session header with the supplied id and timestamp", () => {
    const [line1] = buildSessionLines(result, "my-uuid", "2026-06-01T12:00:00.000Z").split("\n");
    const header = JSON.parse(line1);
    expect(header.type).toBe("session");
    expect(header.id).toBe("my-uuid");
    expect(header.timestamp).toBe("2026-06-01T12:00:00.000Z");
    expect(header.cwd).toBe(result.cwd);
    expect(header.version).toBe(CURRENT_SESSION_VERSION);
  });

  it("line 2 is a pit CustomEntry with the worktree metadata", () => {
    const [, line2] = buildSessionLines(result, "uuid", "ts").split("\n");
    const entry = JSON.parse(line2);
    expect(entry.type).toBe("custom");
    expect(entry.customType).toBe("pit");
    expect(entry.parentId).toBeNull();
    expect(entry.data.id).toBe(result.meta.id);
    expect(entry.data.branch).toBe(result.meta.branch);
  });

  it("line 3 is a custom_message with display:true that chains to line 2", () => {
    const [, line2, line3] = buildSessionLines(result, "uuid", "ts").split("\n");
    const custom = JSON.parse(line2);
    const msg = JSON.parse(line3);
    expect(msg.type).toBe("custom_message");
    expect(msg.display).toBe(true);
    expect(msg.parentId).toBe(custom.id);
  });

  it("sandbox section appears in line 3 content when mounts provided", () => {
    const mounts: SandboxMounts = { ro: [{ path: "/home", label: "home directory" }], rw: [{ path: result.cwd }] };
    const [, , line3] = buildSessionLines(result, "uuid", "ts", mounts).split("\n");
    expect(JSON.parse(line3).content).toContain("Sandbox (bwrap)");
  });

  it("sandbox section absent when no mounts provided", () => {
    const [, , line3] = buildSessionLines(result, "uuid", "ts").split("\n");
    expect(JSON.parse(line3).content).not.toContain("Sandbox (bwrap)");
  });

  it("calling twice produces different id1/id2 values (not hardcoded)", () => {
    const a = JSON.parse(buildSessionLines(result, "u", "t").split("\n")[1]).id;
    const b = JSON.parse(buildSessionLines(result, "u", "t").split("\n")[1]).id;
    // With high probability two 4-byte random hex strings differ
    expect(a).not.toBe(b);
  });
});

// ── buildSandboxMountSpec ─────────────────────────────────────────────────────
//
// Pure mount-list assembler. Callers resolve all IO (git rw mounts, overlay
// dirs) and pass pre-computed arrays.

describe("buildSandboxMountSpec", () => {
  const base = {
    home: "/home/user",
    cwd: "/home/user/repo-wt-abc",
    agentDirReal: "/home/user/.pi/agent",
    extensionMounts: [],
    nodeDir: "/usr/local",
    gitRwMounts: [] as Array<{ path: string; label?: string }>,
    overlayDirs: [] as OverlayMount[],
  };

  it("ro section includes home directory entry", () => {
    const mounts = buildSandboxMountSpec(base);
    expect(mounts.ro.some((m) => m.label === "home directory")).toBe(true);
  });

  it("ro section includes /usr and /etc as system dirs", () => {
    const mounts = buildSandboxMountSpec(base);
    const systemPaths = mounts.ro.filter((m) => m.label === "system dirs").map((m) => m.path);
    expect(systemPaths).toContain("/usr");
    expect(systemPaths).toContain("/etc");
  });

  it("rw section includes the cwd", () => {
    const mounts = buildSandboxMountSpec(base);
    expect(mounts.rw.some((m) => m.path === base.cwd)).toBe(true);
  });

  it("rw section includes the agentDirReal as Pi config dir", () => {
    const mounts = buildSandboxMountSpec(base);
    expect(mounts.rw.some((m) => m.label === "Pi config dir" && m.path === base.agentDirReal)).toBe(true);
  });

  it("extension mounts appear in ro section labelled 'Pi extensions'", () => {
    const mounts = buildSandboxMountSpec({ ...base, extensionMounts: ["/ext/foo.ts", "/ext/bar.ts"] });
    const extEntries = mounts.ro.filter((m) => m.label === "Pi extensions");
    expect(extEntries.map((m) => m.path)).toContain("/ext/foo.ts");
    expect(extEntries.map((m) => m.path)).toContain("/ext/bar.ts");
  });

  it("gitRwMounts appear at the start of the rw section", () => {
    const gitMounts = [
      { path: "/repo/.git/worktrees/wt", label: "worktree git metadata" },
      { path: "/repo/.git/objects",      label: "git objects" },
    ];
    const mounts = buildSandboxMountSpec({ ...base, gitRwMounts: gitMounts });
    expect(mounts.rw[0].label).toBe("worktree git metadata");
    expect(mounts.rw[1].label).toBe("git objects");
  });

  it("overlayDirs appear in the overlay field", () => {
    const overlayDirs: OverlayMount[] = [
      { src: "/repo/node_modules", dest: "/repo-wt/node_modules", label: "node_modules" },
    ];
    const mounts = buildSandboxMountSpec({ ...base, overlayDirs });
    expect(mounts.overlay).toHaveLength(1);
    expect(mounts.overlay![0].label).toBe("node_modules");
  });

  it("empty overlayDirs produces an empty overlay array", () => {
    const mounts = buildSandboxMountSpec(base);
    expect(mounts.overlay).toEqual([]);
  });

  it("home path drives the npm + mise + nodeDir rw entries", () => {
    const mounts = buildSandboxMountSpec({ ...base, home: "/custom/home", nodeDir: "/custom/node" });
    const rwPaths = mounts.rw.map((m) => m.path);
    expect(rwPaths).toContain("/custom/home/.npm");
    expect(rwPaths).toContain("/custom/home/.local/share/mise/shims");
    expect(rwPaths).toContain("/custom/node/lib/node_modules");
    expect(rwPaths).toContain("/custom/node/bin");
  });
});

// ── systemPromptArgs ──────────────────────────────────────────────────────────
//
// Thin wrapper that packages the announcement into --append-system-prompt args.

describe("systemPromptArgs", () => {
  const meta: PitMetadata = {
    id: "abc",
    repo: "/repo",
    worktree: "/repo-wt-abc",
    branch: "pi/abc",
    created: "2026-01-01T00:00:00.000Z",
    mode: "worktree",
  };

  it("returns a two-element array", () => {
    expect(systemPromptArgs(meta, undefined)).toHaveLength(2);
  });

  it("first element is --append-system-prompt", () => {
    expect(systemPromptArgs(meta, undefined)[0]).toBe("--append-system-prompt");
  });

  it("second element is the buildAnnouncement output", () => {
    expect(systemPromptArgs(meta, undefined)[1]).toBe(buildAnnouncement(meta, undefined));
  });

  it("sandbox section is included when mounts are provided", () => {
    const mounts: SandboxMounts = { ro: [{ path: "/home" }], rw: [{ path: "/work" }] };
    expect(systemPromptArgs(meta, mounts)[1]).toContain("Sandbox (bwrap)");
  });
});

const TEST_SANDBOX = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "test-sandbox"
);
