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
  it("sets repo", () => {
    expect(buildNoTreeMeta("/my/repo").repo).toBe("/my/repo");
  });
  it("branch is always empty", () => {
    expect(buildNoTreeMeta("/repo").branch).toBe("");
  });
  it("does not store mode, noTreeReason, id, created", () => {
    const m = buildNoTreeMeta("/repo") as unknown as Record<string, unknown>;
    expect(m["mode"]).toBeUndefined();
    expect(m["noTreeReason"]).toBeUndefined();
    expect(m["id"]).toBeUndefined();
    expect(m["created"]).toBeUndefined();
  });
});

describe("buildWorktreeMeta", () => {
  it("stores repo", () => {
    expect(buildWorktreeMeta("/my/repo", "pi/abc12345").repo).toBe("/my/repo");
  });
  it("stores supplied branch", () => {
    expect(buildWorktreeMeta("/repo", "pi/abc12345").branch).toBe("pi/abc12345");
  });
  it("does not store mode, id, created", () => {
    const m = buildWorktreeMeta("/repo", "pi/abc") as unknown as Record<string, unknown>;
    expect(m["mode"]).toBeUndefined();
    expect(m["id"]).toBeUndefined();
    expect(m["created"]).toBeUndefined();
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

// ── backward compat: old-format PitMetadata ───────────────────────────────────
//
// Old sessions carry extra fields that new code doesn't write.
// At runtime (JSON.parse), the extra fields are present in the object.
// New code must only rely on repo and branch — extra fields are noise.

describe("PitMetadata backward compat: old extra fields ignored", () => {
  it("object with old fields still provides repo and branch", () => {
    // Simulate what JSON.parse produces for an old session file
    const old = {
      id: "deadbeef",
      repo: "/home/user/repo",
      worktree: "/home/user/repo-wt-deadbeef",
      branch: "pi/deadbeef",
      created: "2026-01-01T00:00:00.000Z",
      mode: "worktree",
    } as unknown as import("../../types.ts").PitMetadata;

    expect(old.repo).toBe("/home/user/repo");
    expect(old.branch).toBe("pi/deadbeef");
  });

  it("old no-tree session (branch: '') is recoverable as no-tree", () => {
    const old = {
      id: "abc12345",
      repo: "/home/user/project",
      worktree: "/home/user/project",
      branch: "",
      created: "2026-01-01T00:00:00.000Z",
      mode: "no-tree",
      noTreeReason: "no-repo",
    } as unknown as import("../../types.ts").PitMetadata;

    // New code uses branch === "" to detect no-tree — must work with old objects
    expect(old.branch).toBe("");
    expect(old.repo).toBe("/home/user/project");
  });
});
