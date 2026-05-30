import { describe, it, expect } from "vitest";
import { run, useTmpDirs } from "../../tests/helpers.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager, CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { setupNewSession, refreshPitBranchIfStale } from "./io.ts";
import { cwdToBucket } from "./pure.ts";
import type { WorktreeResult, SandboxMounts } from "../../types.ts";

const { makeSandbox } = useTmpDirs();

const makeResult = (overrides: Partial<WorktreeResult> = {}): WorktreeResult => ({
  cwd: "/tmp/test-repo-wt-a1b2c3d4",
  meta: { repo: "/tmp/test-repo", branch: "pi/a1b2c3d4" },
  ...overrides,
});

// ── setupNewSession ───────────────────────────────────────────────────────────
//
// Writes the session file scaffold: header + pit CustomEntry + visible banner.
// Must use direct JSONL writes — SessionManager buffers in-memory and only
// flushes when pi itself opens the session.

describe("setupNewSession", () => {
  it("actually writes the file to disk (guards against SessionManager buffering regression)", async () => {
    const agentDir = makeSandbox("pit-session-agent-");
    expect(fs.existsSync(await run(setupNewSession(makeResult(), agentDir)))).toBe(true);
  });
  it("places the file under the correct bucket for the cwd", async () => {
    const agentDir = makeSandbox("pit-session-agent-");
    const result = makeResult();
    const f = await run(setupNewSession(result, agentDir));
    expect(f).toContain(path.join(agentDir, "sessions", cwdToBucket(result.cwd)));
  });
  it("file has exactly 2 lines without sandbox (header + pit entry)", async () => {
    const agentDir = makeSandbox("pit-session-agent-");
    const lines = fs.readFileSync(await run(setupNewSession(makeResult(), agentDir)), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });
  it("line 1 is a valid session header with correct version and cwd", async () => {
    const agentDir = makeSandbox("pit-session-agent-");
    const result = makeResult();
    const h = JSON.parse(fs.readFileSync(await run(setupNewSession(result, agentDir)), "utf8").split("\n")[0]);
    expect(h.type).toBe("session");
    expect(h.version).toBe(CURRENT_SESSION_VERSION);
    expect(h.cwd).toBe(result.cwd);
    expect(typeof h.id).toBe("string");
    expect(typeof h.timestamp).toBe("string");
  });
  it("line 2 is a pit CustomEntry carrying the worktree metadata", async () => {
    const agentDir = makeSandbox("pit-session-agent-");
    const result = makeResult();
    const lines = fs.readFileSync(await run(setupNewSession(result, agentDir)), "utf8").trim().split("\n");
    const e = JSON.parse(lines[1]);
    expect(e.type).toBe("custom");
    expect(e.customType).toBe("pit");
    expect(e.parentId).toBeNull();
    expect(e.data.repo).toBe(result.meta.repo);
    expect(e.data.branch).toBe(result.meta.branch);
    // mode, id, created, worktree not stored in metadata
    expect(e.data.mode).toBeUndefined();
    expect(e.data.id).toBeUndefined();
  });
  it("session file can be opened by SessionManager (pi compatibility check)", async () => {
    const agentDir = makeSandbox("pit-session-agent-");
    const f = await run(setupNewSession(makeResult(), agentDir));
    expect(() => SessionManager.open(f)).not.toThrow();
    expect(SessionManager.open(f).getEntries().length).toBe(1);
  });
  it("SessionManager can locate the pit CustomEntry for pit -r", async () => {
    const agentDir = makeSandbox("pit-session-agent-");
    const result = makeResult();
    const f = await run(setupNewSession(result, agentDir));
    const pitEntry = SessionManager.open(f).getEntries()
      .find((e) => e.type === "custom" && (e as { customType?: string }).customType === "pit");
    expect(pitEntry).toBeDefined();
    expect((pitEntry as { data?: { branch?: string } }).data?.branch).toBe(result.meta.branch);
  });
  it("file has exactly 2 lines when not sandboxed (no custom_message banner)", async () => {
    const agentDir = makeSandbox("pit-session-agent-");
    const lines = fs.readFileSync(await run(setupNewSession(makeResult(), agentDir)), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });
  it("file has exactly 3 lines when sandboxed (adds sandbox banner)", async () => {
    const agentDir = makeSandbox("pit-session-agent-");
    const result = makeResult();
    const mounts: SandboxMounts = { ro: [{ path: "/home/user", label: "home directory" }], rw: [{ path: result.cwd }] };
    const lines = fs.readFileSync(await run(setupNewSession(result, agentDir, mounts)), "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2]).type).toBe("custom_message");
    expect(JSON.parse(lines[2]).content).toContain("Sandbox (bwrap)");
  });
});

// ── refreshPitBranchIfStale ───────────────────────────────────────────────────
//
// Rewrites the branch in the pit CustomEntry when it has changed.
// Safe because it runs before pi starts — no concurrent writer.

import { buildSessionLines } from "./pure.ts";

describe("refreshPitBranchIfStale", () => {
  function makeSessionWithBranch(agentDir: string, branch: string): string {
    const result: WorktreeResult = { cwd: "/tmp/test-wt", meta: { repo: "/tmp/test-repo", branch } };
    const dir = path.join(agentDir, "sessions", "--tmp-test-wt--");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "session.jsonl");
    fs.writeFileSync(file, buildSessionLines(result, "test-uuid-1234", "2026-01-01T00:00:00.000Z"));
    return file;
  }

  it("returns false when branch is already up-to-date", async () => {
    const agentDir = makeSandbox("refresh-agent-");
    const file = makeSessionWithBranch(agentDir, "pi/abc12345");
    const result = await run(refreshPitBranchIfStale(file, "pi/abc12345"));
    expect(result).toBe(false);
  });

  it("returns true and rewrites when branch is stale", async () => {
    const agentDir = makeSandbox("refresh-agent-");
    const file = makeSessionWithBranch(agentDir, "pi/old-name");
    const result = await run(refreshPitBranchIfStale(file, "pi/new-name"));
    expect(result).toBe(true);
  });

  it("branch is updated in the file after rewrite", async () => {
    const agentDir = makeSandbox("refresh-agent-");
    const file = makeSessionWithBranch(agentDir, "pi/old-name");
    await run(refreshPitBranchIfStale(file, "pi/new-name"));

    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    const pitEntry = JSON.parse(lines[1]) as { data: { branch: string } };
    expect(pitEntry.data.branch).toBe("pi/new-name");
  });

  it("file line count does not change after rewrite", async () => {
    const agentDir = makeSandbox("refresh-agent-");
    const file = makeSessionWithBranch(agentDir, "pi/old-name");
    const before = fs.readFileSync(file, "utf8").trim().split("\n").length;
    await run(refreshPitBranchIfStale(file, "pi/new-name"));
    const after = fs.readFileSync(file, "utf8").trim().split("\n").length;
    expect(after).toBe(before);
  });

  it("non-pit lines are preserved after rewrite", async () => {
    const agentDir = makeSandbox("refresh-agent-");
    const file = makeSessionWithBranch(agentDir, "pi/old-name");
    const headerBefore = JSON.parse(fs.readFileSync(file, "utf8").split("\n")[0]);
    await run(refreshPitBranchIfStale(file, "pi/new-name"));
    const headerAfter = JSON.parse(fs.readFileSync(file, "utf8").split("\n")[0]);
    expect(headerAfter).toEqual(headerBefore); // header unchanged
  });

  it("returns false when no pit entry exists in the file", async () => {
    const agentDir = makeSandbox("refresh-agent-");
    // Write a session with only a header (no pit entry)
    const dir = fs.mkdtempSync(path.join(agentDir, "bucket-"));
    const file = path.join(dir, "session.jsonl");
    fs.writeFileSync(file, JSON.stringify({ type: "session", id: "x", cwd: "/tmp", timestamp: "t" }) + "\n");
    const result = await run(refreshPitBranchIfStale(file, "pi/new-name"));
    expect(result).toBe(false);
  });
});
