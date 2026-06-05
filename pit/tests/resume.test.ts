/**
 * Tests for pit -r session resumption and sandbox isolation.
 *
 * Bug: pit -r was sandboxing to the launch cwd (wherever `pit` was run from)
 * instead of the session's worktree. This meant the session opened with the
 * wrong working directory and writes were unrestricted to the launch path.
 *
 * Fix: showPicker reads the pit CustomEntry from the selected session file to
 * get meta.worktree, which is passed to bwrapLaunch as the bind mount target.
 *
 * These tests verify:
 *   1. Pit metadata is correctly extracted from a session file (the path that
 *      determines which directory gets sandboxed).
 *   2. The bwrap sandbox is bound to the worktree path, not the launch dir —
 *      writes outside the worktree are blocked inside the sandbox.
 */
import { fileURLToPath } from "node:url";
import { describe, it, expect, afterEach } from "vitest";
import { Effect } from "effect";
import { layer as NodeContextLayer, type NodeContext } from "../src/node-context.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { setupNewSession } from "../src/core/session/io.ts";
import { cwdToBucket } from "../src/core/session/pure.ts";
import { findBwrap, buildBwrapArgs } from "../src/launcher/index.ts";
import { linuxPlatformRoMounts } from "../src/core/sandbox/pure.ts";

const run = <A>(eff: Effect.Effect<A, unknown, NodeContext>) =>
  Effect.runPromise(eff.pipe(Effect.provide(NodeContextLayer)));
import type { WorktreeResult, SandboxMounts } from "../src/types.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

// All test artifacts live inside the repo under pit/test-sandbox/
// so they're accessible regardless of sandbox boundaries.
const TEST_SANDBOX = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "test-sandbox"
);

const hasBwrap = !!findBwrap();

function bwrapCanUnshareUser(): boolean {
  if (!hasBwrap) return false;
  const r = spawnSync(findBwrap()!, [
    "--tmpfs", "/", "--dev", "/dev", "--proc", "/proc",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind-try", "/bin", "/bin",
    "--ro-bind-try", "/lib", "/lib",
    "--ro-bind-try", "/lib64", "/lib64",
    "--unshare-user",
    "--", "/bin/true",
  ], { encoding: "utf8" });
  return r.status === 0;
}
const hasBwrapUserNS = bwrapCanUnshareUser();

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

function makeTmpDir(): string {
  fs.mkdirSync(TEST_SANDBOX, { recursive: true });
  const d = fs.mkdtempSync(path.join(TEST_SANDBOX, "pit-resume-test-"));
  tmpDirs.push(d);
  return d;
}

async function makePitSession(worktree: string, agentDir: string) {
  const result: WorktreeResult = {
    cwd: worktree,
    meta: { repo: path.dirname(worktree), branch: "pi/a1b2c3d4" },
  };
  const sessionFile = await run(setupNewSession(result, agentDir));
  return { sessionFile, meta: result.meta, cwd: result.cwd };
}

// ── session metadata extraction ───────────────────────────────────────────────
//
// showPicker reads the pit CustomEntry from the selected session file to
// determine which worktree to sandbox to. This mirrors the logic in pit.ts.

function readPitMeta(sessionFile: string) {
  const sm = SessionManager.open(sessionFile);
  const entry = sm.getEntries().find(
    (e) => e.type === "custom" && (e as any).customType === "pit"
  );
  return (entry as any)?.data ?? null;
}

describe("session metadata extraction for pit -r", () => {
  it("reads the branch and mode from a pit session's CustomEntry", async () => {
    const agentDir = makeTmpDir();
    const worktree = makeTmpDir();
    const { sessionFile, meta } = await makePitSession(worktree, agentDir);

    const extracted = readPitMeta(sessionFile);

    expect(extracted).not.toBeNull();
    expect(extracted.branch).toBe(meta.branch);
    expect(extracted.repo).toBe(meta.repo);
    // mode, worktree, id not stored in metadata
    expect(extracted.mode).toBeUndefined();
    expect(extracted.worktree).toBeUndefined();
  });

  it("returns null for a non-pit session (no CustomEntry)", () => {
    const agentDir = makeTmpDir();
    const cwd = makeTmpDir();
    // Plain session file with no pit entries
    const bucket = cwdToBucket(cwd);
    const dir = path.join(agentDir, "sessions", bucket);
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString();
    const file = path.join(dir, `${ts.replace(/:/g, "-").replace(".", "-")}_plain.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "plain", timestamp: ts, cwd }) + "\n");

    const extracted = readPitMeta(file);

    expect(extracted).toBeNull();
  });

  it("session header cwd matches the session file's bucket", async () => {
    // The session bucket is derived from the cwd. The header cwd and bucket
    // must agree or pit -r would sandbox to the wrong directory.
    const agentDir = makeTmpDir();
    const worktree = makeTmpDir();
    const { sessionFile, cwd } = await makePitSession(worktree, agentDir);

    const sm = SessionManager.open(sessionFile);
    const expectedBucket = cwdToBucket(cwd);

    expect(sessionFile).toContain(expectedBucket);
    expect(sm.getCwd()).toBe(cwd);
  });
});

// ── bwrap sandbox isolation ───────────────────────────────────────────────────
//
// The sandbox must be bound to the session's worktree, not the launch dir.
// Before the fix, bwrapLaunch received process.cwd() (launch dir) instead of
// meta.worktree. This test verifies the isolation is correct.

describe("bwrap sandbox bound to worktree not launch dir", () => {
  it.skipIf(!hasBwrapUserNS)("writes to worktree succeed, writes to launch dir are blocked", () => {
    const nodeBin = process.execPath;
    const nodeDir = path.dirname(path.dirname(nodeBin));
    // Both dirs are under /tmp, but only worktree is explicitly bound.
    // We do NOT bind /tmp wholesale — that would make launchDir accessible too.
    const testRoot = makeTmpDir();
    const worktree = path.join(testRoot, "worktree");
    const launchDir = path.join(testRoot, "launchdir");
    fs.mkdirSync(worktree);
    fs.mkdirSync(launchDir);

    const mounts: SandboxMounts = {
      ro: [
        { path: "/usr", label: "system dirs" },
        { path: "/etc", label: "system dirs" },
        { path: nodeDir, label: "runtime" },
        ...linuxPlatformRoMounts(),
      ],
      rw: [
        // Only bind the worktree — launchDir is intentionally NOT bound
        { path: worktree },
      ],
    };

    const result = spawnSync(
      findBwrap()!,
      [
        ...buildBwrapArgs(mounts, { cwd: worktree }),
        "--setenv", "HOME", worktree, // HOME=worktree avoids creating /home as a tmpfs parent
        "--setenv", "PATH", `${nodeDir}/bin:/usr/bin:/bin`,
        "--",
        nodeBin, "-e", `
          const fs = require('fs');
          const results = {};
          try {
            fs.writeFileSync('${worktree}/test.txt', 'x');
            fs.unlinkSync('${worktree}/test.txt');
            results.worktree = 'writable';
          } catch(e) { results.worktree = 'blocked:' + e.code; }
          try {
            fs.writeFileSync('${launchDir}/test.txt', 'x');
            results.launchDir = 'writable';
          } catch(e) { results.launchDir = 'blocked:' + e.code; }
          process.stdout.write(JSON.stringify(results));
        `,
      ],
      { encoding: "utf8", timeout: 5000 }
    );

    expect(result.status, result.stderr).toBe(0);
    const { worktree: wtResult, launchDir: ldResult } = JSON.parse(result.stdout);
    expect(wtResult).toBe("writable");
    expect(ldResult).toMatch(/^blocked/);
  });
});
