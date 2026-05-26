import { describe, it, expect, afterEach } from "vitest";
import { Effect } from "effect";
import { NodeContext } from "@effect/platform-node";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isLinkedWorktree, resolveMainRepo, readWorktreeBranch } from "./utils.ts";

const run = <A>(eff: Effect.Effect<A, unknown, NodeContext.NodeContext>) =>
  Effect.runPromise(eff.pipe(Effect.provide(NodeContext.layer)));

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});
const makeDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pit-git-test-"));
  tmpDirs.push(d);
  return d;
};

describe("isLinkedWorktree", () => {
  it("returns false when .git does not exist", async () => {
    expect(await run(isLinkedWorktree(makeDir()))).toBe(false);
  });
  it("returns false when .git is a directory (main checkout)", async () => {
    const d = makeDir();
    fs.mkdirSync(path.join(d, ".git"));
    expect(await run(isLinkedWorktree(d))).toBe(false);
  });
  it("returns true for a linked worktree .git file", async () => {
    const d = makeDir();
    fs.writeFileSync(path.join(d, ".git"), "gitdir: /repo/.git/worktrees/wt-abc\n");
    expect(await run(isLinkedWorktree(d))).toBe(true);
  });
  it("returns false for a submodule (.git file with /modules/)", async () => {
    const d = makeDir();
    fs.writeFileSync(path.join(d, ".git"), "gitdir: ../.git/modules/sub\n");
    expect(await run(isLinkedWorktree(d))).toBe(false);
  });
  it("returns false for a non-existent path", async () => {
    expect(await run(isLinkedWorktree("/nonexistent/pit-test"))).toBe(false);
  });
  it("handles gitdir without trailing newline", async () => {
    const d = makeDir();
    fs.writeFileSync(path.join(d, ".git"), "gitdir: /repo/.git/worktrees/abc");
    expect(await run(isLinkedWorktree(d))).toBe(true);
  });
  it("any /worktrees/ path returns true regardless of branch name", async () => {
    const d = makeDir();
    fs.writeFileSync(path.join(d, ".git"), "gitdir: /repo/.git/worktrees/my-custom-name\n");
    expect(await run(isLinkedWorktree(d))).toBe(true);
  });
});

describe("resolveMainRepo", () => {
  it("returns null for non-existent path", async () => {
    expect(await run(resolveMainRepo("/nonexistent/pit-test"))).toBeNull();
  });
  it("returns null when .git is a directory", async () => {
    const d = makeDir();
    fs.mkdirSync(path.join(d, ".git"));
    expect(await run(resolveMainRepo(d))).toBeNull();
  });
  it("returns null for a submodule", async () => {
    const d = makeDir();
    fs.writeFileSync(path.join(d, ".git"), "gitdir: ../.git/modules/sub\n");
    expect(await run(resolveMainRepo(d))).toBeNull();
  });
  it("returns the parent repo root for a linked worktree", async () => {
    const parentRepo = makeDir();
    const wtDir = path.join(parentRepo, ".git", "worktrees", "wt-abc");
    fs.mkdirSync(wtDir, { recursive: true });
    const wt = makeDir();
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${wtDir}\n`);
    expect(await run(resolveMainRepo(wt))).toBe(parentRepo);
  });
  it("works for any worktree name", async () => {
    const parentRepo = makeDir();
    const wtDir = path.join(parentRepo, ".git", "worktrees", "feature-branch");
    fs.mkdirSync(wtDir, { recursive: true });
    const wt = makeDir();
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${wtDir}\n`);
    expect(await run(resolveMainRepo(wt))).toBe(parentRepo);
  });
  it("handles gitdir without trailing newline", async () => {
    const parentRepo = makeDir();
    const wtDir = path.join(parentRepo, ".git", "worktrees", "wt-x");
    fs.mkdirSync(wtDir, { recursive: true });
    const wt = makeDir();
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${wtDir}`);
    expect(await run(resolveMainRepo(wt))).toBe(parentRepo);
  });
});

describe("readWorktreeBranch", () => {
  it("returns null when no .git", async () => {
    expect(await run(readWorktreeBranch(makeDir()))).toBeNull();
  });
  it("returns null when .git is a directory", async () => {
    const d = makeDir();
    fs.mkdirSync(path.join(d, ".git"));
    expect(await run(readWorktreeBranch(d))).toBeNull();
  });
  it("returns null for a submodule", async () => {
    const d = makeDir();
    fs.writeFileSync(path.join(d, ".git"), "gitdir: ../.git/modules/sub\n");
    expect(await run(readWorktreeBranch(d))).toBeNull();
  });
  it("returns the branch name for a linked worktree", async () => {
    const d = makeDir();
    const gitdir = path.join(makeDir() + "-repo", ".git", "worktrees", "wt");
    fs.mkdirSync(gitdir, { recursive: true });
    tmpDirs.push(d + "-repo");
    fs.writeFileSync(path.join(gitdir, "HEAD"), "ref: refs/heads/pi/abc1234\n");
    fs.writeFileSync(path.join(d, ".git"), `gitdir: ${gitdir}\n`);
    expect(await run(readWorktreeBranch(d))).toBe("pi/abc1234");
  });
  it("returns null for detached HEAD", async () => {
    const d = makeDir();
    const gitdir = path.join(makeDir() + "-repo2", ".git", "worktrees", "wt");
    fs.mkdirSync(gitdir, { recursive: true });
    tmpDirs.push(d + "-repo2");
    fs.writeFileSync(path.join(gitdir, "HEAD"), "abc1234def5678\n");
    fs.writeFileSync(path.join(d, ".git"), `gitdir: ${gitdir}\n`);
    expect(await run(readWorktreeBranch(d))).toBeNull();
  });
  it("returns null for non-existent path", async () => {
    expect(await run(readWorktreeBranch("/nonexistent/pit-test-wt"))).toBeNull();
  });
});
