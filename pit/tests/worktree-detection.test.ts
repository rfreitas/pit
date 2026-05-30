/**
 * Tests for findPitSession and listRepoWorktrees.
 *
 * findPitSession — scans the sessions directory for a given cwd and returns
 *   the most recent pit session. Lets the new-session path in pit.ts detect
 *   when it's already inside a worktree it owns and resume instead of nesting.
 *
 * listRepoWorktrees — enumerates linked worktrees for a git repo via
 *   `git worktree list --porcelain`. Used by showPicker to merge worktree
 *   sessions into the current-tab loader.
 *
 * Both use os.tmpdir() for scratch space so these tests work from any cwd.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Effect } from "effect";
import { NodeContext } from "@effect/platform-node";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { setupNewSession, findPitSession } from "../src/core/session/io.ts";
import { listRepoWorktrees } from "../src/core/git/utils.ts";

const run = <A>(eff: Effect.Effect<A, unknown, NodeContext.NodeContext>) =>
  Effect.runPromise(eff.pipe(Effect.provide(NodeContext.layer)));
import { cwdToBucket } from "../src/core/session/pure.ts";
import type { WorktreeResult, PitMetadata } from "../src/types.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

function makeTmpDir(prefix: string): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}

function makeWorktreeResult(cwd: string, id = "a1b2c3d4"): WorktreeResult {
  return {
    cwd,
    meta: { repo: path.dirname(cwd), branch: `pi/${id}` } satisfies PitMetadata,
  };
}

/** Create a minimal git repo with an initial commit, return its path. */
function makeGitRepo(): string {
  const repo = makeTmpDir("pit-repo-");
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.email", "test@pit.test"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.name", "pit test"], { stdio: "ignore" });
  fs.writeFileSync(path.join(repo, ".gitkeep"), "");
  execFileSync("git", ["-C", repo, "add", "."], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "commit", "-m", "init"], { stdio: "ignore" });
  return repo;
}

/** Add a linked worktree at a fresh temp path and return its path. */
function addWorktree(repo: string, branch: string): string {
  const wt = makeTmpDir("pit-wt-");
  // mkdtemp creates the dir; git worktree add requires it to not exist
  fs.rmSync(wt, { recursive: true, force: true });
  tmpDirs[tmpDirs.indexOf(wt)] = wt; // keep in cleanup list
  execFileSync("git", ["-C", repo, "worktree", "add", "-b", branch, wt], { stdio: "ignore" });
  return wt;
}

// ── findPitSession ────────────────────────────────────────────────────────────
//
// The function scans the session bucket for a cwd, opens each session file,
// and returns the most recent one that has a pit CustomEntry. It accepts
// agentDir so tests can point it at a temp directory instead of ~/.pi/agent.

describe("findPitSession", () => {
  it("returns null when no sessions exist for the cwd", async () => {
    const agentDir = makeTmpDir("pit-agent-");
    const cwd = "/tmp/fake-worktree-that-has-no-sessions";
    expect(await run(findPitSession(cwd, agentDir))).toBeNull();
  });

  it("returns null when sessions exist but none are pit sessions", async () => {
    // Manually write a session file without a pit CustomEntry
    const agentDir = makeTmpDir("pit-agent-");
    const cwd = "/tmp/fake-worktree-no-pit";

    // Use SessionManager.create to produce a vanilla session (no pit custom entry)
    const { SessionManager: SM, CURRENT_SESSION_VERSION } = await import("@earendil-works/pi-coding-agent");
    const sessionDir = path.join(agentDir, "sessions", "--tmp-fake-worktree-no-pit--");
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, `2026-01-01T00-00-00-000Z_${crypto.randomUUID()}.jsonl`);
    const line = JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: crypto.randomUUID(), timestamp: new Date().toISOString(), cwd });
    fs.writeFileSync(sessionFile, line + "\n");

    expect(await run(findPitSession(cwd, agentDir))).toBeNull();
  });

  it("returns the session file and metadata when a pit session exists", async () => {
    const agentDir = makeTmpDir("pit-agent-");
    const cwd = "/tmp/fake-worktree-with-pit";
    const result = makeWorktreeResult(cwd, "deadbeef");

    const sessionFile = await run(setupNewSession(result, agentDir));

    const found = await run(findPitSession(cwd, agentDir));
    expect(found).not.toBeNull();
    expect(found!.sessionFile).toBe(sessionFile);
    expect(found!.meta.branch).toBe("pi/deadbeef");
    expect(found!.meta.branch).toBe("pi/deadbeef");
  });

  it("returns the most recently modified session when multiple exist", async () => {
    const agentDir = makeTmpDir("pit-agent-");
    const cwd = "/tmp/fake-worktree-multi";

    // Create two sessions with a small delay to get distinct modified times
    const result1 = makeWorktreeResult(cwd, "11111111");
    await run(setupNewSession(result1, agentDir));

    // Small sleep to ensure different modified timestamps
    await new Promise((r) => setTimeout(r, 10));

    const result2 = makeWorktreeResult(cwd, "22222222");
    const newer = await run(setupNewSession(result2, agentDir));

    const found = await run(findPitSession(cwd, agentDir));
    expect(found).not.toBeNull();
    expect(found!.sessionFile).toBe(newer);
    expect(found!.meta.branch).toBe("pi/22222222");
  });

  it("the returned session can be opened by SessionManager (pi compatibility)", async () => {
    const agentDir = makeTmpDir("pit-agent-");
    const cwd = "/tmp/fake-worktree-compat";
    await run(setupNewSession(makeWorktreeResult(cwd), agentDir));

    const found = await run(findPitSession(cwd, agentDir));
    expect(() => SessionManager.open(found!.sessionFile)).not.toThrow();
  });
});

// ── listRepoWorktrees ─────────────────────────────────────────────────────────
//
// Parses `git worktree list --porcelain` and returns linked worktree paths,
// excluding the main repo itself. Used to build the merged session loader in
// showPicker so all pit sessions for a repo appear on the current-tab.

describe("listRepoWorktrees", () => {
  it("returns an empty array for a non-git directory", async () => {
    const dir = makeTmpDir("pit-nongit-");
    expect(await run(listRepoWorktrees(dir))).toEqual([]);
  });

  it("returns an empty array for a git repo with no linked worktrees", async () => {
    const repo = makeGitRepo();
    expect(await run(listRepoWorktrees(repo))).toEqual([]);
  });

  it("returns the linked worktree path for a repo with one worktree", async () => {
    const repo = makeGitRepo();
    const wt = addWorktree(repo, "pi/test1");
    const result = await run(listRepoWorktrees(repo));
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(wt);
  });

  it("returns all linked worktrees for a repo with multiple worktrees", async () => {
    const repo = makeGitRepo();
    const wt1 = addWorktree(repo, "pi/test1");
    const wt2 = addWorktree(repo, "pi/test2");
    const result = await run(listRepoWorktrees(repo));
    expect(result).toHaveLength(2);
    expect(result).toContain(wt1);
    expect(result).toContain(wt2);
  });

  it("does not include the main repo in the result", async () => {
    const repo = makeGitRepo();
    addWorktree(repo, "pi/test1");
    const result = await run(listRepoWorktrees(repo));
    expect(result).not.toContain(repo);
  });

  it("works for worktrees on any branch name, not just pi/", async () => {
    const repo = makeGitRepo();
    const wt = addWorktree(repo, "feature/my-feature");
    const result = await run(listRepoWorktrees(repo));
    expect(result).toContain(wt);
  });
});

// node crypto is available as a global in Node but not imported — grab it inline
import * as crypto from "node:crypto";
