import { fileURLToPath } from "node:url";
import { describe, it, expect, afterEach } from "vitest";
import { Effect } from "effect";
import { NodeContext } from "@effect/platform-node";
import * as fs from "node:fs";
import * as path from "node:path";
import { dirname } from "node:path";
import { SessionManager, CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { setupNewSession } from "./io.ts";
import { cwdToBucket } from "./pure.ts";
import type { WorktreeResult, SandboxMounts } from "../../types.ts";

const TEST_SANDBOX = path.join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "test-sandbox");
fs.mkdirSync(TEST_SANDBOX, { recursive: true });

const run = <A>(eff: Effect.Effect<A, unknown, NodeContext.NodeContext>) =>
  Effect.runPromise(eff.pipe(Effect.provide(NodeContext.layer)));

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});
const makeAgentDir = () => {
  const d = fs.mkdtempSync(path.join(TEST_SANDBOX, "pit-session-agent-"));
  tmpDirs.push(d);
  return d;
};
const makeResult = (overrides: Partial<WorktreeResult> = {}): WorktreeResult => ({
  mode: "worktree",
  cwd: "/tmp/test-repo-wt-a1b2c3d4",
  meta: {
    id: "a1b2c3d4", repo: "/tmp/test-repo", worktree: "/tmp/test-repo-wt-a1b2c3d4",
    branch: "pi/a1b2c3d4", created: "2026-01-01T00:00:00.000Z", mode: "worktree",
  },
  ...overrides,
});

describe("setupNewSession", () => {
  it("writes the file to disk (guards against SessionManager buffering regression)", async () => {
    const agentDir = makeAgentDir();
    const f = await run(setupNewSession(makeResult(), agentDir));
    expect(fs.existsSync(f)).toBe(true);
  });
  it("places the file under the correct bucket for the cwd", async () => {
    const agentDir = makeAgentDir();
    const result = makeResult();
    const f = await run(setupNewSession(result, agentDir));
    expect(f).toContain(path.join(agentDir, "sessions", cwdToBucket(result.cwd)));
  });
  it("file has exactly 3 lines (header + custom + custom_message)", async () => {
    const agentDir = makeAgentDir();
    const f = await run(setupNewSession(makeResult(), agentDir));
    expect(fs.readFileSync(f, "utf8").trim().split("\n")).toHaveLength(3);
  });
  it("line 1 is session header with correct version and cwd", async () => {
    const agentDir = makeAgentDir();
    const result = makeResult();
    const f = await run(setupNewSession(result, agentDir));
    const h = JSON.parse(fs.readFileSync(f, "utf8").split("\n")[0]);
    expect(h.type).toBe("session");
    expect(h.version).toBe(CURRENT_SESSION_VERSION);
    expect(h.cwd).toBe(result.cwd);
  });
  it("line 2 is pit CustomEntry with metadata", async () => {
    const agentDir = makeAgentDir();
    const result = makeResult();
    const f = await run(setupNewSession(result, agentDir));
    const e = JSON.parse(fs.readFileSync(f, "utf8").split("\n")[1]);
    expect(e.type).toBe("custom");
    expect(e.customType).toBe("pit");
    expect(e.data.id).toBe(result.meta.id);
    expect(e.data.branch).toBe(result.meta.branch);
  });
  it("file is readable by SessionManager", async () => {
    const agentDir = makeAgentDir();
    const f = await run(setupNewSession(makeResult(), agentDir));
    expect(() => SessionManager.open(f)).not.toThrow();
    expect(SessionManager.open(f).getEntries().length).toBe(2);
  });
  it("SessionManager can locate the pit CustomEntry", async () => {
    const agentDir = makeAgentDir();
    const result = makeResult();
    const f = await run(setupNewSession(result, agentDir));
    const pitEntry = SessionManager.open(f).getEntries()
      .find((e) => e.type === "custom" && (e as { customType?: string }).customType === "pit");
    expect(pitEntry).toBeDefined();
    expect((pitEntry as { data?: { id?: string } }).data?.id).toBe(result.meta.id);
  });
  it("line 3 is custom_message with display:true", async () => {
    const agentDir = makeAgentDir();
    const lines = fs.readFileSync(await run(setupNewSession(makeResult(), agentDir)), "utf8").trim().split("\n");
    const msg = JSON.parse(lines[2]);
    expect(msg.type).toBe("custom_message");
    expect(msg.display).toBe(true);
  });
  it("line 3 parentId chains to line 2 id", async () => {
    const agentDir = makeAgentDir();
    const lines = fs.readFileSync(await run(setupNewSession(makeResult(), agentDir)), "utf8").trim().split("\n");
    expect(JSON.parse(lines[2]).parentId).toBe(JSON.parse(lines[1]).id);
  });
  it("announcement includes sandbox section when mounts provided", async () => {
    const agentDir = makeAgentDir();
    const result = makeResult();
    const mounts: SandboxMounts = { ro: [{ path: "/home/user", label: "home directory" }], rw: [{ path: result.cwd }] };
    const lines = fs.readFileSync(await run(setupNewSession(result, agentDir, mounts)), "utf8").trim().split("\n");
    expect(JSON.parse(lines[2]).content).toContain("Sandbox (bwrap)");
  });
  it("announcement omits sandbox section when no mounts", async () => {
    const agentDir = makeAgentDir();
    const lines = fs.readFileSync(await run(setupNewSession(makeResult(), agentDir)), "utf8").trim().split("\n");
    expect(JSON.parse(lines[2]).content).not.toContain("Sandbox (bwrap)");
  });
});
