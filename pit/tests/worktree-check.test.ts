/**
 * Tests for worktreeCheckEffect that require real git operations.
 * These live in pit/tests/ (not pit/src/) because they need
 * real git subprocess execution — no spawnSync mocks here.
 *
 * Covers:
 *   - dir missing + branch exists → recreates worktree
 *   - dir missing + branch deleted → WorktreeMissingError
 *   - new session (forceNoTree in git repo) → repo === git root
 *   - new session (worktree created) → branch stored in metadata
 */
import { describe, it, expect, afterEach } from "vitest";
import { Effect } from "effect";
import { NodeContext } from "@effect/platform-node";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { worktreeCheckEffect } from "../src/core/worktree/io.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

function makeTmp(prefix = "pit-wc-"): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function makeGitRepo(): string {
  const repo = makeTmp("pit-repo-");
  execFileSync("git", ["-C", repo, "init", "-b", "main", "-q"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  fs.writeFileSync(path.join(repo, "dummy.txt"), "hello world");
  execFileSync("git", ["-C", repo, "add", "dummy.txt"]);
  execFileSync("git", ["-C", repo, "commit", "-m", "init", "-q"]);
  return repo;
}

const run = <A, E>(eff: Effect.Effect<A, E, NodeContext.NodeContext>) =>
  Effect.runPromise(eff.pipe(Effect.provide(NodeContext.layer)));

// ── worktreeCheckEffect — git-dependent ───────────────────────────────────────

describe("worktreeCheckEffect — recreation (requires real git)", () => {

  it("dir missing + branch exists: recreates worktree and returns it", async () => {
    const repo = makeGitRepo();
    const worktree = path.join(path.dirname(repo), path.basename(repo) + "-wt-test");
    const branch = "pi/recreate-test";

    execFileSync("git", ["-C", repo, "worktree", "add", "-b", branch, worktree, "HEAD"]);
    tmpDirs.push(worktree);

    // Simulate deletion
    fs.rmSync(worktree, { recursive: true, force: true });
    expect(fs.existsSync(worktree)).toBe(false);

    const result = await run(worktreeCheckEffect({ meta: { repo, branch }, cwd: worktree }));

    expect(result.cwd).toBe(worktree);
    expect(fs.existsSync(worktree)).toBe(true);
  });

  it("dir missing + branch deleted: throws WorktreeMissingError", async () => {
    const repo = makeGitRepo();
    const worktree = repo + "-wt-no-such-branch";
    const meta = { repo, branch: "pi/branch-that-never-existed" };

    await expect(
      run(worktreeCheckEffect({ meta, cwd: worktree })),
    ).rejects.toThrow();
  });

  it("recreated worktree has meta.repo and meta.branch intact", async () => {
    const repo = makeGitRepo();
    const worktree = path.join(path.dirname(repo), path.basename(repo) + "-wt-meta");
    const branch = "pi/meta-test";

    execFileSync("git", ["-C", repo, "worktree", "add", "-b", branch, worktree, "HEAD"]);
    tmpDirs.push(worktree);
    fs.rmSync(worktree, { recursive: true, force: true });

    const meta = { repo, branch };
    const result = await run(worktreeCheckEffect({ meta, cwd: worktree }));

    expect(result.meta.repo).toBe(repo);
    expect(result.meta.branch).toBe(branch);
  });
});

describe("worktreeCheckEffect — new session path (requires real git)", () => {
  let savedCwd = process.cwd();

  afterEach(() => {
    try { process.chdir(savedCwd); } catch { /* ignore */ }
  });

  it("forceNoTree in git repo: meta.branch is '' and meta.repo is git root", async () => {
    savedCwd = process.cwd();
    const repo = makeGitRepo();
    process.chdir(repo);

    const result = await run(worktreeCheckEffect(undefined, true));

    expect(result.meta.branch).toBe("");
    expect(result.meta.repo).toBe(repo);
  });

  it("new worktree created: cwd is worktree path, meta.branch is pi/<id>", async () => {
    savedCwd = process.cwd();
    const repo = makeGitRepo();
    process.chdir(repo);

    const result = await run(worktreeCheckEffect(undefined, false));

    // cwd is the new worktree, not the main repo
    expect(result.cwd).not.toBe(repo);
    expect(result.cwd).toMatch(/-wt-/);
    expect(fs.existsSync(result.cwd)).toBe(true);
    expect(result.meta.branch).toMatch(/^pi\//);
    expect(result.meta.repo).toBe(repo);
    tmpDirs.push(result.cwd);

    // Cleanup worktree
    execFileSync("git", ["-C", repo, "worktree", "remove", result.cwd]);
    execFileSync("git", ["-C", repo, "branch", "-D", result.meta.branch]);
  });

  it("new worktree: meta stores only repo and branch (no mode/id/created)", async () => {
    savedCwd = process.cwd();
    const repo = makeGitRepo();
    process.chdir(repo);

    const result = await run(worktreeCheckEffect(undefined, false));
    const raw = result.meta as unknown as Record<string, unknown>;

    expect(Object.keys(raw).sort()).toEqual(["branch", "repo"]);
    tmpDirs.push(result.cwd);
    execFileSync("git", ["-C", repo, "worktree", "remove", result.cwd]);
    execFileSync("git", ["-C", repo, "branch", "-D", result.meta.branch]);
  });
});

describe("worktreeCheckEffect — the 5 Row-Item open behaviors", () => {
  it("Row 1: Active Worktree (Healthy) — Direct Open (No-op)", async () => {
    const repo = makeGitRepo();
    const worktree = path.join(path.dirname(repo), path.basename(repo) + "-wt-row1");
    const branch = "pi/row1";

    execFileSync("git", ["-C", repo, "worktree", "add", "-b", branch, worktree, "HEAD"]);
    tmpDirs.push(worktree);

    const originalMtime = fs.statSync(path.join(worktree, "dummy.txt")).mtimeMs;

    const result = await run(worktreeCheckEffect({ meta: { repo, branch }, cwd: worktree }));

    expect(result.cwd).toBe(worktree);
    expect(fs.statSync(path.join(worktree, "dummy.txt")).mtimeMs).toBe(originalMtime); // Verifies no filesystem changes
  });

  it("Row 2: Missing Worktree (Branch Exists) — Recreates", async () => {
    const repo = makeGitRepo();
    const worktree = path.join(path.dirname(repo), path.basename(repo) + "-wt-row2");
    const branch = "pi/row2";

    execFileSync("git", ["-C", repo, "worktree", "add", "-b", branch, worktree, "HEAD"]);
    tmpDirs.push(worktree);

    // Physically delete folder, keep branch
    fs.rmSync(worktree, { recursive: true, force: true });
    expect(fs.existsSync(worktree)).toBe(false);

    const result = await run(worktreeCheckEffect({ meta: { repo, branch }, cwd: worktree }));

    expect(result.cwd).toBe(worktree);
    expect(fs.existsSync(worktree)).toBe(true); // Verifies it was automatically recreated
  });

  it("Row 3: Deleted Branch (Folder Missing) — Throws WorktreeMissingError", async () => {
    const repo = makeGitRepo();
    const worktree = path.join(path.dirname(repo), path.basename(repo) + "-wt-row3");
    const branch = "pi/row3";

    // Deleted branch & folder missing
    await expect(
      run(worktreeCheckEffect({ meta: { repo, branch }, cwd: worktree })),
    ).rejects.toThrow(); // Throws WorktreeMissingError (caught by program.ts to trigger prompt)
  });

  it("Row 4: Deleted Branch (Folder Exists) — Direct Non-Destructive Open", async () => {
    const repo = makeGitRepo();
    const worktree = path.join(path.dirname(repo), path.basename(repo) + "-wt-row4");
    const branch = "pi/row4";

    execFileSync("git", ["-C", repo, "worktree", "add", "-b", branch, worktree, "HEAD"]);
    tmpDirs.push(worktree);

    // Break the link (delete .git file) and prune so Git lets us delete the branch
    fs.unlinkSync(path.join(worktree, ".git"));
    execFileSync("git", ["-C", repo, "worktree", "prune"]);

    // Now Git will allow us to delete the branch because it is no longer locked as active
    execFileSync("git", ["-C", repo, "branch", "-D", branch]);

    const result = await run(worktreeCheckEffect({ meta: { repo, branch }, cwd: worktree }));

    expect(result.cwd).toBe(worktree);
    expect(fs.existsSync(worktree)).toBe(true); // Verifies folder remains untouched
  });

  it("Row 5: Unregistered Worktree (Folder Exists, Branch Exists) — Direct Non-Destructive Open", async () => {
    const repo = makeGitRepo();
    const worktree = path.join(path.dirname(repo), path.basename(repo) + "-wt-row5");
    const branch = "pi/row5";

    execFileSync("git", ["-C", repo, "worktree", "add", "-b", branch, worktree, "HEAD"]);
    tmpDirs.push(worktree);

    // Break the link (delete .git), making it unregistered
    fs.unlinkSync(path.join(worktree, ".git"));

    const result = await run(worktreeCheckEffect({ meta: { repo, branch }, cwd: worktree }));

    expect(result.cwd).toBe(worktree);
    expect(fs.existsSync(worktree)).toBe(true); // Verifies folder remains untouched
  });
});
