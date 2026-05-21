/**
 * Tests for findOrCreateLinkedSession.
 *
 * This function handles the linked-worktree dispatch path: find the existing
 * pit session for a cwd, or create a fresh no-tree session if none exists.
 * Sandbox settings (settingsPath, writeFilteredSettings) are handled by the
 * caller (pit.ts), not here.
 *
 * What's tested:
 *   - No existing session → kind "new", correct metadata written to disk
 *   - Existing session → kind "resume", original session file returned
 *   - "new" session has noTreeReason: "linked-worktree"
 *   - "resume" session preserves the original metadata intact
 *   - Does not create a new file when resuming
 */
import { fileURLToPath } from "node:url";
import { describe, it, expect, afterEach } from "vitest";
import { Effect } from "effect";
import { NodeContext } from "@effect/platform-node";
import * as fs from "node:fs";
import * as path from "node:path";
import { setupNewSession, findOrCreateLinkedSession } from "../session/io.ts";
import { cwdToBucket } from "../session/pure.ts";
import type { WorktreeResult, PitMetadata } from "../types.ts";

const run = <A>(eff: Effect.Effect<A, unknown, NodeContext.NodeContext>) =>
  Effect.runPromise(eff.pipe(Effect.provide(NodeContext.layer)));

// ── helpers ───────────────────────────────────────────────────────────────────

const TEST_SANDBOX = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "test-sandbox"
);

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

function makeDir(prefix = "pit-lwt-test-"): string {
  fs.mkdirSync(TEST_SANDBOX, { recursive: true });
  const d = fs.mkdtempSync(path.join(TEST_SANDBOX, prefix));
  tmpDirs.push(d);
  return d;
}

function makeAgentDir(): string {
  return makeDir("agent-");
}

/** Seed an existing pit session for cwd in agentDir. Returns the session file path. */
async function seedSession(cwd: string, agentDir: string, id = "a1b2c3d4"): Promise<string> {
  const result: WorktreeResult = {
    mode: "worktree",
    cwd,
    meta: {
      id,
      repo: path.dirname(cwd),
      worktree: cwd,
      branch: `pi/${id}`,
      created: new Date().toISOString(),
      mode: "worktree",
    } satisfies PitMetadata,
  };
  return run(setupNewSession(result, agentDir));
}

// ── kind: "new" (no existing session) ────────────────────────────────────────

describe("findOrCreateLinkedSession — no existing session", () => {
  it("returns kind 'new'", async () => {
    const session = await run(findOrCreateLinkedSession(makeDir("cwd-"), makeAgentDir()));
    expect(session.kind).toBe("new");
  });

  it("creates a session file on disk", async () => {
    const session = await run(findOrCreateLinkedSession(makeDir("cwd-"), makeAgentDir()));
    expect(fs.existsSync(session.sessionFile)).toBe(true);
  });

  it("meta has mode 'no-tree' and noTreeReason 'linked-worktree'", async () => {
    const session = await run(findOrCreateLinkedSession(makeDir("cwd-"), makeAgentDir()));
    expect(session.meta.mode).toBe("no-tree");
    expect(session.meta.noTreeReason).toBe("linked-worktree");
  });

  it("meta.worktree and meta.repo are set to cwd", async () => {
    const cwd = makeDir("cwd-");
    const session = await run(findOrCreateLinkedSession(cwd, makeAgentDir()));
    expect(session.meta.worktree).toBe(cwd);
    expect(session.meta.repo).toBe(cwd);
  });

  it("meta.branch is empty string", async () => {
    const session = await run(findOrCreateLinkedSession(makeDir("cwd-"), makeAgentDir()));
    expect(session.meta.branch).toBe("");
  });

  it("session file is in the correct bucket for cwd", async () => {
    const cwd = makeDir("cwd-");
    const agentDir = makeAgentDir();
    const session = await run(findOrCreateLinkedSession(cwd, agentDir));
    expect(session.sessionFile).toContain(path.join(agentDir, "sessions", cwdToBucket(cwd)));
  });
});

// ── kind: "resume" (existing session found) ───────────────────────────────────

describe("findOrCreateLinkedSession — existing session", () => {
  it("returns kind 'resume'", async () => {
    const agentDir = makeAgentDir();
    const cwd = makeDir("cwd-");
    await seedSession(cwd, agentDir);
    const session = await run(findOrCreateLinkedSession(cwd, agentDir));
    expect(session.kind).toBe("resume");
  });

  it("returns the existing session file path", async () => {
    const agentDir = makeAgentDir();
    const cwd = makeDir("cwd-");
    const seeded = await seedSession(cwd, agentDir, "deadbeef");
    const session = await run(findOrCreateLinkedSession(cwd, agentDir));
    expect(session.sessionFile).toBe(seeded);
  });

  it("meta matches the seeded session's metadata", async () => {
    const agentDir = makeAgentDir();
    const cwd = makeDir("cwd-");
    await seedSession(cwd, agentDir, "cafebabe");
    const session = await run(findOrCreateLinkedSession(cwd, agentDir));
    expect(session.meta.id).toBe("cafebabe");
    expect(session.meta.branch).toBe("pi/cafebabe");
  });

  it("does NOT create a new session file when resuming", async () => {
    const agentDir = makeAgentDir();
    const cwd = makeDir("cwd-");
    const seeded = await seedSession(cwd, agentDir);
    const bucketDir = path.dirname(seeded);
    const before = fs.readdirSync(bucketDir).length;
    await run(findOrCreateLinkedSession(cwd, agentDir));
    expect(fs.readdirSync(bucketDir).length).toBe(before);
  });

  it("most recent session is returned when multiple exist", async () => {
    const agentDir = makeAgentDir();
    const cwd = makeDir("cwd-");
    await seedSession(cwd, agentDir, "11111111");
    await new Promise((r) => setTimeout(r, 10));
    const newer = await seedSession(cwd, agentDir, "22222222");
    const session = await run(findOrCreateLinkedSession(cwd, agentDir));
    expect(session.sessionFile).toBe(newer);
    expect(session.meta.id).toBe("22222222");
  });
});
