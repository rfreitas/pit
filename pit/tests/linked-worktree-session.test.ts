/**
 * Regression tests for prepareLinkedWorktreeSession.
 *
 * This function was introduced to replace the inline linked-worktree dispatch
 * block in pit.ts after two bugs were found there during the git-helper →
 * pit-escape transition:
 *
 *   Bug A — wrong env var: PIT_GIT_SOCKET was set instead of PIT_ESCAPE_SOCKET,
 *            so the git tool silently never activated in linked-worktree sessions.
 *
 *   Bug B — missing settingsPath: the filtered settings file was never written
 *            or passed to launch(), so the denylist had no effect when running
 *            pit from inside an existing worktree.
 *
 * The function encapsulates the three steps that must always happen together:
 *   1. Find or create the session
 *   2. Compute settingsPath when sandboxed
 *   3. Write the filtered settings so bwrap's shadow dir picks them up
 *
 * What's tested:
 *   - No existing session → kind "new", correct metadata written to disk
 *   - Existing session → kind "resume", original session file returned
 *   - sandbox + hasBwrap → settingsPath defined, filtered settings written (Bug B)
 *   - !sandbox or !hasBwrap → settingsPath undefined (no spurious file)
 *   - Denylist is applied to the written settings file
 *   - "new" session has noTreeReason: "linked-worktree"
 *   - "resume" session preserves the original metadata intact
 */
import { fileURLToPath } from "node:url";
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  prepareLinkedWorktreeSession,
  setupNewSession,
  type WorktreeResult,
  type PitMetadata,
} from "../utils.ts";

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

/** Create a temp agentDir with optional settings.json */
function makeAgentDir(settings?: object): string {
  const d = makeDir("agent-");
  if (settings) {
    fs.writeFileSync(path.join(d, "settings.json"), JSON.stringify(settings));
  }
  return d;
}

/** Create a temp pitDir with optional config.json */
function makePitDir(config?: object): string {
  const d = makeDir("pit-");
  if (config) {
    fs.writeFileSync(path.join(d, "config.json"), JSON.stringify(config));
  }
  return d;
}

/** Seed an existing pit session for cwd in agentDir. Returns the session file path. */
function seedSession(cwd: string, agentDir: string, id = "a1b2c3d4"): string {
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
  return setupNewSession(result, agentDir);
}

// ── kind: "new" (no existing session) ────────────────────────────────────────

describe("prepareLinkedWorktreeSession — no existing session", () => {
  it("returns kind 'new'", async () => {
    const cwd = makeDir("cwd-");
    const session = await prepareLinkedWorktreeSession({
      cwd,
      agentDir: makeAgentDir(),
      pitDir: makePitDir(),
      useSandbox: false,
      hasBwrap: false,
    });
    expect(session.kind).toBe("new");
  });

  it("creates a session file on disk", async () => {
    const cwd = makeDir("cwd-");
    const session = await prepareLinkedWorktreeSession({
      cwd,
      agentDir: makeAgentDir(),
      pitDir: makePitDir(),
      useSandbox: false,
      hasBwrap: false,
    });
    expect(fs.existsSync(session.sessionFile)).toBe(true);
  });

  it("meta has mode 'no-tree' and noTreeReason 'linked-worktree'", async () => {
    const cwd = makeDir("cwd-");
    const session = await prepareLinkedWorktreeSession({
      cwd,
      agentDir: makeAgentDir(),
      pitDir: makePitDir(),
      useSandbox: false,
      hasBwrap: false,
    });
    expect(session.meta.mode).toBe("no-tree");
    expect(session.meta.noTreeReason).toBe("linked-worktree");
  });

  it("meta.worktree and meta.repo are set to cwd", async () => {
    const cwd = makeDir("cwd-");
    const session = await prepareLinkedWorktreeSession({
      cwd,
      agentDir: makeAgentDir(),
      pitDir: makePitDir(),
      useSandbox: false,
      hasBwrap: false,
    });
    expect(session.meta.worktree).toBe(cwd);
    expect(session.meta.repo).toBe(cwd);
  });

  it("meta.branch is empty (no-tree has no branch)", async () => {
    const cwd = makeDir("cwd-");
    const session = await prepareLinkedWorktreeSession({
      cwd,
      agentDir: makeAgentDir(),
      pitDir: makePitDir(),
      useSandbox: false,
      hasBwrap: false,
    });
    expect(session.meta.branch).toBe("");
  });
});

// ── kind: "resume" (existing session found) ───────────────────────────────────

describe("prepareLinkedWorktreeSession — existing session", () => {
  it("returns kind 'resume'", async () => {
    const agentDir = makeAgentDir();
    const cwd = makeDir("cwd-");
    seedSession(cwd, agentDir);
    const session = await prepareLinkedWorktreeSession({
      cwd,
      agentDir,
      pitDir: makePitDir(),
      useSandbox: false,
      hasBwrap: false,
    });
    expect(session.kind).toBe("resume");
  });

  it("returns the existing session file path", async () => {
    const agentDir = makeAgentDir();
    const cwd = makeDir("cwd-");
    const seeded = seedSession(cwd, agentDir, "deadbeef");
    const session = await prepareLinkedWorktreeSession({
      cwd,
      agentDir,
      pitDir: makePitDir(),
      useSandbox: false,
      hasBwrap: false,
    });
    expect(session.sessionFile).toBe(seeded);
  });

  it("meta matches the seeded session's metadata", async () => {
    const agentDir = makeAgentDir();
    const cwd = makeDir("cwd-");
    seedSession(cwd, agentDir, "cafebabe");
    const session = await prepareLinkedWorktreeSession({
      cwd,
      agentDir,
      pitDir: makePitDir(),
      useSandbox: false,
      hasBwrap: false,
    });
    expect(session.meta.id).toBe("cafebabe");
    expect(session.meta.branch).toBe("pi/cafebabe");
  });

  it("does NOT create a new session file", async () => {
    const agentDir = makeAgentDir();
    const cwd = makeDir("cwd-");
    const seeded = seedSession(cwd, agentDir);
    const bucketDir = path.dirname(seeded);
    const before = fs.readdirSync(bucketDir).length;
    await prepareLinkedWorktreeSession({
      cwd,
      agentDir,
      pitDir: makePitDir(),
      useSandbox: false,
      hasBwrap: false,
    });
    expect(fs.readdirSync(bucketDir).length).toBe(before);
  });
});

// ── settingsPath — regression for Bug B ──────────────────────────────────────
//
// The original linked-worktree code paths never generated or passed settingsPath
// to launch(), so the denylist was silently ignored when running pit from inside
// a worktree. These tests pin the correct behaviour.

describe("prepareLinkedWorktreeSession — settingsPath (Bug B regression)", () => {
  it("settingsPath is defined when useSandbox && hasBwrap", async () => {
    const cwd = makeDir("cwd-");
    const session = await prepareLinkedWorktreeSession({
      cwd,
      agentDir: makeAgentDir({ packages: [] }),
      pitDir: makePitDir(),
      useSandbox: true,
      hasBwrap: true,
    });
    expect(session.settingsPath).toBeDefined();
  });

  it("settingsPath is undefined when useSandbox is false", async () => {
    const cwd = makeDir("cwd-");
    const session = await prepareLinkedWorktreeSession({
      cwd,
      agentDir: makeAgentDir({ packages: [] }),
      pitDir: makePitDir(),
      useSandbox: false,
      hasBwrap: true,
    });
    expect(session.settingsPath).toBeUndefined();
  });

  it("settingsPath is undefined when hasBwrap is false", async () => {
    const cwd = makeDir("cwd-");
    const session = await prepareLinkedWorktreeSession({
      cwd,
      agentDir: makeAgentDir({ packages: [] }),
      pitDir: makePitDir(),
      useSandbox: true,
      hasBwrap: false,
    });
    expect(session.settingsPath).toBeUndefined();
  });

  it("the settings file is written to disk when settingsPath is defined", async () => {
    const cwd = makeDir("cwd-");
    const session = await prepareLinkedWorktreeSession({
      cwd,
      agentDir: makeAgentDir({ packages: [] }),
      pitDir: makePitDir(),
      useSandbox: true,
      hasBwrap: true,
    });
    expect(fs.existsSync(session.settingsPath!)).toBe(true);
  });

  it("no settings file is written when settingsPath is undefined", async () => {
    const pitDir = makePitDir();
    const cwd = makeDir("cwd-");
    await prepareLinkedWorktreeSession({
      cwd,
      agentDir: makeAgentDir({ packages: ["npm:some-pkg"] }),
      pitDir,
      useSandbox: false,
      hasBwrap: true,
    });
    const sessionsDir = path.join(pitDir, "sessions");
    expect(fs.existsSync(sessionsDir)).toBe(false);
  });

  it("denylist is applied to the written settings file", async () => {
    const denied = "npm:@casualjim/pi-heimdall";
    const allowed = "npm:pi-agent-browser-native";
    const cwd = makeDir("cwd-");
    const session = await prepareLinkedWorktreeSession({
      cwd,
      agentDir: makeAgentDir({ packages: [denied, allowed] }),
      pitDir: makePitDir({ denyPackages: [denied] }),
      useSandbox: true,
      hasBwrap: true,
    });
    const written = JSON.parse(fs.readFileSync(session.settingsPath!, "utf8"));
    expect(written.packages).not.toContain(denied);
    expect(written.packages).toContain(allowed);
  });

  it("denylist is applied on resume too (not only new sessions)", async () => {
    const denied = "npm:@casualjim/pi-heimdall";
    const allowed = "npm:pi-agent-browser-native";
    const agentDir = makeAgentDir({ packages: [denied, allowed] });
    const cwd = makeDir("cwd-");
    seedSession(cwd, agentDir);
    const session = await prepareLinkedWorktreeSession({
      cwd,
      agentDir,
      pitDir: makePitDir({ denyPackages: [denied] }),
      useSandbox: true,
      hasBwrap: true,
    });
    const written = JSON.parse(fs.readFileSync(session.settingsPath!, "utf8"));
    expect(written.packages).not.toContain(denied);
    expect(written.packages).toContain(allowed);
  });

  it("settingsPath is inside pitDir/sessions/", async () => {
    const pitDir = makePitDir();
    const cwd = makeDir("cwd-");
    const session = await prepareLinkedWorktreeSession({
      cwd,
      agentDir: makeAgentDir({ packages: [] }),
      pitDir,
      useSandbox: true,
      hasBwrap: true,
    });
    expect(session.settingsPath!).toContain(path.join(pitDir, "sessions"));
  });
});
