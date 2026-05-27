import { describe, it, expect } from "vitest";
import { run, useTmpDirs } from "../../tests/helpers.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager, CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { setupNewSession } from "./io.ts";
import { cwdToBucket } from "./pure.ts";
import type { WorktreeResult, SandboxMounts } from "../../types.ts";

const { makeSandbox } = useTmpDirs();

const makeResult = (overrides: Partial<WorktreeResult> = {}): WorktreeResult => ({
  mode: "worktree",
  cwd: "/tmp/test-repo-wt-a1b2c3d4",
  meta: {
    id: "a1b2c3d4", repo: "/tmp/test-repo", worktree: "/tmp/test-repo-wt-a1b2c3d4",
    branch: "pi/a1b2c3d4", created: "2026-01-01T00:00:00.000Z", mode: "worktree",
  },
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
  it("file has exactly 3 lines (header + custom metadata + custom_message)", async () => {
    const agentDir = makeSandbox("pit-session-agent-");
    const lines = fs.readFileSync(await run(setupNewSession(makeResult(), agentDir)), "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
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
    expect(e.data.id).toBe(result.meta.id);
    expect(e.data.branch).toBe(result.meta.branch);
    expect(e.data.worktree).toBe(result.meta.worktree);
    expect(e.data.mode).toBe("worktree");
  });
  it("session file can be opened by SessionManager (pi compatibility check)", async () => {
    const agentDir = makeSandbox("pit-session-agent-");
    const f = await run(setupNewSession(makeResult(), agentDir));
    expect(() => SessionManager.open(f)).not.toThrow();
    expect(SessionManager.open(f).getEntries().length).toBe(2);
  });
  it("SessionManager can locate the pit CustomEntry for pit -r", async () => {
    const agentDir = makeSandbox("pit-session-agent-");
    const result = makeResult();
    const f = await run(setupNewSession(result, agentDir));
    const pitEntry = SessionManager.open(f).getEntries()
      .find((e) => e.type === "custom" && (e as { customType?: string }).customType === "pit");
    expect(pitEntry).toBeDefined();
    expect((pitEntry as { data?: { id?: string } }).data?.id).toBe(result.meta.id);
  });
  it("line 3 is a CustomMessageEntry with display: true (TUI banner)", async () => {
    const agentDir = makeSandbox("pit-session-agent-");
    const lines = fs.readFileSync(await run(setupNewSession(makeResult(), agentDir)), "utf8").trim().split("\n");
    const msg = JSON.parse(lines[2]);
    expect(msg.type).toBe("custom_message");
    expect(msg.customType).toBe("pit");
    expect(msg.display).toBe(true);
  });
  it("CustomMessageEntry parentId chains to CustomEntry id", async () => {
    const agentDir = makeSandbox("pit-session-agent-");
    const lines = fs.readFileSync(await run(setupNewSession(makeResult(), agentDir)), "utf8").trim().split("\n");
    expect(JSON.parse(lines[2]).parentId).toBe(JSON.parse(lines[1]).id);
  });
  it("announcement includes sandbox section when mounts provided", async () => {
    const agentDir = makeSandbox("pit-session-agent-");
    const result = makeResult();
    const mounts: SandboxMounts = { ro: [{ path: "/home/user", label: "home directory" }], rw: [{ path: result.cwd }] };
    const lines = fs.readFileSync(await run(setupNewSession(result, agentDir, mounts)), "utf8").trim().split("\n");
    expect(JSON.parse(lines[2]).content).toContain("Sandbox (bwrap)");
  });
  it("announcement omits sandbox section when no mounts provided", async () => {
    const agentDir = makeSandbox("pit-session-agent-");
    const lines = fs.readFileSync(await run(setupNewSession(makeResult(), agentDir)), "utf8").trim().split("\n");
    expect(JSON.parse(lines[2]).content).not.toContain("Sandbox (bwrap)");
  });
  it("no-tree mode announcement tells user there is no git repo", async () => {
    // The announcement text differs by mode — agents need the right framing.
    const agentDir = makeSandbox("pit-session-agent-");
    const result: WorktreeResult = {
      mode: "no-tree", cwd: "/tmp/some-dir",
      meta: { id: "b2c3d4e5", repo: "/tmp/some-dir", worktree: "/tmp/some-dir",
              branch: "", created: "2026-01-01T00:00:00.000Z", mode: "no-tree" },
    };
    const lines = fs.readFileSync(await run(setupNewSession(result, agentDir)), "utf8").trim().split("\n");
    expect(JSON.parse(lines[2]).content).toContain("no-tree mode");
  });
});
