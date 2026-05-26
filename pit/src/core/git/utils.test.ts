import { describe, it, expect } from "vitest";
import { run, useTmpDirs, TEST_SANDBOX } from "../../tests/helpers.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { Effect } from "effect";
import { NodeContext } from "@effect/platform-node";
import { isLinkedWorktree, resolveMainRepo, readWorktreeBranch } from "./utils.ts";

const { makeTmp } = useTmpDirs();

// ── isLinkedWorktree ──────────────────────────────────────────────────────────
//
// Detects linked git worktrees via the .git-file invariant: a linked worktree
// always has .git as a plain file containing "gitdir: <path>/.git/worktrees/...",
// while the main checkout has .git as a directory and submodules use /modules/.

describe("isLinkedWorktree", () => {
  it("returns false when .git does not exist (non-git dir)", async () => {
    expect(await run(isLinkedWorktree(makeTmp("pit-wt-test-")))).toBe(false);
  });
  it("returns false when .git is a directory (main checkout)", async () => {
    const d = makeTmp("pit-wt-test-");
    fs.mkdirSync(path.join(d, ".git"));
    expect(await run(isLinkedWorktree(d))).toBe(false);
  });
  it("returns true when .git file contains a /worktrees/ gitdir (linked worktree)", async () => {
    const d = makeTmp("pit-wt-test-");
    fs.writeFileSync(path.join(d, ".git"), "gitdir: /home/user/repo/.git/worktrees/wt-abc\n");
    expect(await run(isLinkedWorktree(d))).toBe(true);
  });
  it("returns false when .git file contains a /modules/ gitdir (submodule)", async () => {
    const d = makeTmp("pit-wt-test-");
    fs.writeFileSync(path.join(d, ".git"), "gitdir: ../.git/modules/sub\n");
    expect(await run(isLinkedWorktree(d))).toBe(false);
  });
  it("returns false for a non-existent directory", async () => {
    expect(await run(isLinkedWorktree("/nonexistent/path/pit-test-should-not-exist"))).toBe(false);
  });
  it("handles gitdir value without trailing newline", async () => {
    const d = makeTmp("pit-wt-test-");
    fs.writeFileSync(path.join(d, ".git"), "gitdir: /repo/.git/worktrees/abc");
    expect(await run(isLinkedWorktree(d))).toBe(true);
  });
  it("is insensitive to the branch name — any /worktrees/ path returns true", async () => {
    const d = makeTmp("pit-wt-test-");
    fs.writeFileSync(path.join(d, ".git"), "gitdir: /repo/.git/worktrees/my-custom-name\n");
    expect(await run(isLinkedWorktree(d))).toBe(true);
  });
});

// ── resolveMainRepo ───────────────────────────────────────────────────────────
//
// Resolves the parent repo path from a linked worktree's .git file.
// This gates whether overlay mounts are set up at all: null → no overlays.

describe("resolveMainRepo", () => {
  it("returns null for a non-existent directory", async () => {
    expect(await run(resolveMainRepo("/nonexistent/path/pit-test-should-not-exist"))).toBeNull();
  });
  it("returns null when there is no .git entry (non-git dir)", async () => {
    expect(await run(resolveMainRepo(makeTmp("pit-repo-test-")))).toBeNull();
  });
  it("returns null when .git is a directory (main checkout)", async () => {
    const d = makeTmp("pit-repo-test-");
    fs.mkdirSync(path.join(d, ".git"));
    expect(await run(resolveMainRepo(d))).toBeNull();
  });
  it("returns null for a submodule (.git file with /modules/ not /worktrees/)", async () => {
    const d = makeTmp("pit-repo-test-");
    fs.writeFileSync(path.join(d, ".git"), "gitdir: ../.git/modules/sub\n");
    expect(await run(resolveMainRepo(d))).toBeNull();
  });
  it("returns the parent repo root for a linked worktree", async () => {
    const parentRepo = makeTmp("pit-parent-repo-");
    const wtDir = path.join(parentRepo, ".git", "worktrees", "wt-abc");
    fs.mkdirSync(wtDir, { recursive: true });
    const wt = makeTmp("pit-wt-");
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${wtDir}\n`);
    expect(await run(resolveMainRepo(wt))).toBe(parentRepo);
  });
  it("works regardless of the worktree name in the gitdir path", async () => {
    const parentRepo = makeTmp("pit-parent-repo-");
    const wtDir = path.join(parentRepo, ".git", "worktrees", "feature-my-branch");
    fs.mkdirSync(wtDir, { recursive: true });
    const wt = makeTmp("pit-wt-");
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${wtDir}\n`);
    expect(await run(resolveMainRepo(wt))).toBe(parentRepo);
  });
  it("handles gitdir without trailing newline", async () => {
    const parentRepo = makeTmp("pit-parent-repo-");
    const wtDir = path.join(parentRepo, ".git", "worktrees", "wt-x");
    fs.mkdirSync(wtDir, { recursive: true });
    const wt = makeTmp("pit-wt-");
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${wtDir}`);
    expect(await run(resolveMainRepo(wt))).toBe(parentRepo);
  });
  it("handles absolute gitdir paths without trailing newline", async () => {
    // The second resolve-from-string case: an absolute path with no trailing newline.
    const d = makeTmp("pit-repo-test-");
    fs.writeFileSync(path.join(d, ".git"), "gitdir: /absolute/repo/.git/worktrees/wt-xyz");
    expect(await run(resolveMainRepo(d))).toBe("/absolute/repo");
  });
  it("handles absolute gitdir paths without trailing newline", async () => {
    const d = makeTmp("pit-repo-test-");
    fs.writeFileSync(path.join(d, ".git"), "gitdir: /absolute/repo/.git/worktrees/wt-xyz");
    expect(await run(resolveMainRepo(d))).toBe("/absolute/repo");
  });
  it("resolves the main repo from a standard linked worktree .git file", async () => {
    const d = makeTmp("pit-repo-test-");
    const mainRepo = "/home/user/repo";
    fs.writeFileSync(path.join(d, ".git"), `gitdir: ${mainRepo}/.git/worktrees/wt-abc\n`);
    expect(await run(resolveMainRepo(d))).toBe(mainRepo);
  });
  it("returns null when .git file references a submodule path (string fixture)", async () => {
    const d = makeTmp("pit-repo-test-");
    fs.writeFileSync(path.join(d, ".git"), "gitdir: /repo/.git/modules/sub\n");
    expect(await run(resolveMainRepo(d))).toBeNull();
  });
  it("returns null for a hardcoded non-existent path", async () => {
    expect(await run(resolveMainRepo("/nonexistent/pit-test-main-repo"))).toBeNull();
  });
});

// ── readWorktreeBranch ────────────────────────────────────────────────────────
//
// Reads the current branch from a linked worktree's .git file without running
// git. Returns null for main checkouts, submodules, detached HEAD, or deleted
// worktrees.

describe("readWorktreeBranch", () => {
  const makeGitdir = (branch: string) => {
    const repo = makeTmp("pit-repo-");
    const gitdir = path.join(repo, ".git", "worktrees", "wt");
    fs.mkdirSync(gitdir, { recursive: true });
    fs.writeFileSync(path.join(gitdir, "HEAD"), `ref: refs/heads/${branch}\n`);
    return gitdir;
  };

  it("returns null for a directory with no .git", async () => {
    expect(await run(readWorktreeBranch(makeTmp("pit-wt-")))).toBeNull();
  });
  it("returns null when .git is a directory (main checkout)", async () => {
    const d = makeTmp("pit-wt-");
    fs.mkdirSync(path.join(d, ".git"));
    expect(await run(readWorktreeBranch(d))).toBeNull();
  });
  it("returns null for a submodule (.git file with /modules/ path)", async () => {
    const d = makeTmp("pit-wt-");
    fs.writeFileSync(path.join(d, ".git"), "gitdir: ../.git/modules/sub\n");
    expect(await run(readWorktreeBranch(d))).toBeNull();
  });
  it("returns the branch name for a linked worktree", async () => {
    const d = makeTmp("pit-wt-");
    const gitdir = makeGitdir("pi/abc1234");
    fs.writeFileSync(path.join(d, ".git"), `gitdir: ${gitdir}\n`);
    expect(await run(readWorktreeBranch(d))).toBe("pi/abc1234");
  });
  it("returns the branch name for non-pit branch names", async () => {
    // pit does not require the pi/ prefix — any branch name must round-trip.
    const d = makeTmp("pit-wt-");
    const gitdir = makeGitdir("feature/my-renamed-branch");
    fs.writeFileSync(path.join(d, ".git"), `gitdir: ${gitdir}\n`);
    expect(await run(readWorktreeBranch(d))).toBe("feature/my-renamed-branch");
  });
  it("returns null for detached HEAD", async () => {
    const d = makeTmp("pit-wt-");
    const repo = makeTmp("pit-repo-");
    const gitdir = path.join(repo, ".git", "worktrees", "wt");
    fs.mkdirSync(gitdir, { recursive: true });
    fs.writeFileSync(path.join(gitdir, "HEAD"), "abc1234def5678\n"); // hash, not a ref
    fs.writeFileSync(path.join(d, ".git"), `gitdir: ${gitdir}\n`);
    expect(await run(readWorktreeBranch(d))).toBeNull();
  });
  it("returns null when the worktree directory does not exist", async () => {
    expect(await run(readWorktreeBranch("/nonexistent/path/pit-test-wt"))).toBeNull();
  });
});
