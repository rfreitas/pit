import { describe, it, expect } from "vitest";
import { parseFlags, buildNoTreeMeta, buildWorktreeMeta, worktreePathFor } from "./pure.ts";

describe("parseFlags", () => {
  it("sandbox defaults to true", () => {
    expect(parseFlags([]).sandbox).toBe(true);
  });
  it("--no-sandbox opts out of bwrap", () => {
    expect(parseFlags(["--no-sandbox"]).sandbox).toBe(false);
  });
  it("--no-sandbox is stripped from argv forwarded to pi", () => {
    const { filteredArgv } = parseFlags(["--model", "sonnet", "--no-sandbox"]);
    expect(filteredArgv).not.toContain("--no-sandbox");
    expect(filteredArgv).toContain("--model");
  });
  it("noTree defaults to false", () => {
    expect(parseFlags([]).noTree).toBe(false);
  });
  it("-nt sets noTree", () => { expect(parseFlags(["-nt"]).noTree).toBe(true); });
  it("--no-tree sets noTree", () => { expect(parseFlags(["--no-tree"]).noTree).toBe(true); });
  it("-nt is stripped", () => {
    expect(parseFlags(["-nt", "--thinking", "high"]).filteredArgv).not.toContain("-nt");
  });
  it("--no-tree is stripped", () => {
    expect(parseFlags(["--no-tree", "hello"]).filteredArgv).not.toContain("--no-tree");
  });
  it("pit-only flags combine with pi flags", () => {
    const r = parseFlags(["--no-sandbox", "-nt", "--model", "sonnet"]);
    expect(r.sandbox).toBe(false);
    expect(r.noTree).toBe(true);
    expect(r.filteredArgv).toEqual(["--model", "sonnet"]);
  });
  it("unrecognised flags pass through unchanged", () => {
    expect(parseFlags(["-r", "--thinking", "high", "hello"]).filteredArgv)
      .toEqual(["-r", "--thinking", "high", "hello"]);
  });
  it("empty argv returns all defaults", () => {
    expect(parseFlags([])).toEqual({ sandbox: true, noTree: false, filteredArgv: [] });
  });
  it("--no-session sets noTree", () => {
    expect(parseFlags(["--no-session"]).noTree).toBe(true);
  });
  it("--no-session forwards to pi", () => {
    expect(parseFlags(["--no-session"]).filteredArgv).toContain("--no-session");
  });
  it("--no-session combined with other flags", () => {
    const r = parseFlags(["--no-session", "--mode", "json", "hello"]);
    expect(r.noTree).toBe(true);
    expect(r.filteredArgv).toEqual(["--no-session", "--mode", "json", "hello"]);
  });
  it("--no-session with --no-sandbox: both take effect", () => {
    const r = parseFlags(["--no-sandbox", "--no-session"]);
    expect(r.sandbox).toBe(false);
    expect(r.noTree).toBe(true);
    expect(r.filteredArgv).toContain("--no-session");
    expect(r.filteredArgv).not.toContain("--no-sandbox");
  });
});

describe("buildNoTreeMeta", () => {
  it("sets mode to 'no-tree'", () => {
    expect(buildNoTreeMeta("/cwd", "/repo", "no-repo", "abc", "ts").mode).toBe("no-tree");
  });
  it("sets noTreeReason for all variants", () => {
    expect(buildNoTreeMeta("/cwd", "/repo", "no-repo",         "a", "t").noTreeReason).toBe("no-repo");
    expect(buildNoTreeMeta("/cwd", "/repo", "forced",          "a", "t").noTreeReason).toBe("forced");
    expect(buildNoTreeMeta("/cwd", "/repo", "linked-worktree", "a", "t").noTreeReason).toBe("linked-worktree");
  });
  it("uses supplied id and timestamp", () => {
    const m = buildNoTreeMeta("/cwd", "/repo", "no-repo", "deadbeef", "2026-06-01T12:00:00.000Z");
    expect(m.id).toBe("deadbeef");
    expect(m.created).toBe("2026-06-01T12:00:00.000Z");
  });
  it("sets repo", () => {
    const m = buildNoTreeMeta("/my/cwd", "/my/repo", "forced", "id", "ts");
    expect(m.repo).toBe("/my/repo");
  });
  it("branch is always empty", () => {
    expect(buildNoTreeMeta("/cwd", "/repo", "no-repo", "id", "ts").branch).toBe("");
  });
  it("does not store worktree (cwd lives in session header)", () => {
    const m = buildNoTreeMeta("/my/cwd", "/my/repo", "forced", "id", "ts");
    expect((m as unknown as Record<string, unknown>)["worktree"]).toBeUndefined();
  });
});

describe("buildWorktreeMeta", () => {
  it("sets mode to 'worktree'", () => {
    expect(buildWorktreeMeta("/repo", "abc12345", "ts").mode).toBe("worktree");
  });
  it("derives branch as pi/<id>", () => {
    expect(buildWorktreeMeta("/repo", "abc12345", "ts").branch).toBe("pi/abc12345");
  });
  it("does not store worktree path (lives in session header cwd)", () => {
    const m = buildWorktreeMeta("/home/user/repo", "abc12345", "ts");
    expect((m as unknown as Record<string, unknown>)["worktree"]).toBeUndefined();
  });
  it("uses supplied id and timestamp", () => {
    const m = buildWorktreeMeta("/repo", "deadbeef", "2026-06-01T00:00:00.000Z");
    expect(m.id).toBe("deadbeef");
    expect(m.created).toBe("2026-06-01T00:00:00.000Z");
  });
  it("sets repo", () => {
    expect(buildWorktreeMeta("/my/repo", "id", "ts").repo).toBe("/my/repo");
  });
});

describe("worktreePathFor", () => {
  it("derives path as <parent>/<basename>-wt-<id>", () => {
    expect(worktreePathFor("/home/user/repo", "abc12345"))
      .toBe("/home/user/repo-wt-abc12345");
  });
  it("uses the repo basename, not the full path", () => {
    expect(worktreePathFor("/a/b/myrepo", "ff00")).toBe("/a/b/myrepo-wt-ff00");
  });
});
