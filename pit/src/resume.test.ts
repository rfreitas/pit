/**
 * TDD tests for pit -r session resumption.
 *
 * Essential invariants:
 *
 *   1. launchEffect passes --session <existing-path> to main() — NOT a new path
 *   2. bwrapLaunch passes --session through to inner.ts args
 *   3. The existing session file is accessible inside bwrap (agent dir mounted)
 *   4. The existing session content survives — no overwrite / blank session
 *   5. worktreeCheckEffect uses session header cwd, not stale pit metadata (handoff compat)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { Effect } from "effect";
import { NodeContext } from "@effect/platform-node";
import { spawnSync } from "node:child_process";
import { SessionManager, CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { useTmpDirs, run } from "./tests/helpers.ts";
import { worktreeCheckEffect, type ExistingSession } from "./core/worktree/io.ts";
import { setupNewSession } from "./core/session/io.ts";
import type { WorktreeResult } from "./types.ts";

// ── mocks ─────────────────────────────────────────────────────────────────────

const mockMain = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const { mockSpawnSync } = vi.hoisted(() => ({
  mockSpawnSync: vi.fn().mockReturnValue({ status: 0 }),
}));

vi.mock("@earendil-works/pi-coding-agent", async (orig) => ({
  ...await orig<typeof import("@earendil-works/pi-coding-agent")>(),
  main: mockMain,
}));

vi.mock("node:child_process", async (orig) => ({
  ...await orig<typeof import("node:child_process")>(),
  spawnSync: mockSpawnSync,
}));

// Stub realpathSync and existsSync so bwrapLaunch can run without real filesystem
vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  return {
    ...real,
    realpathSync: (p: string) => p,
    existsSync: (p: string) => {
      // Make bwrap look installed so findBwrap() returns a path
      if (p === "/usr/bin/bwrap" || p === "/usr/local/bin/bwrap") return true;
      return real.existsSync(p);
    },
  };
});

// ── helpers ───────────────────────────────────────────────────────────────────

const { makeTmp, makeSandbox } = useTmpDirs();

function findBwrapReal(): string | null {
  if (fs.existsSync("/usr/bin/bwrap")) return "/usr/bin/bwrap";
  if (fs.existsSync("/usr/local/bin/bwrap")) return "/usr/local/bin/bwrap";
  return null;
}
const hasBwrap = !!(fs.existsSync("/usr/bin/bwrap") || fs.existsSync("/usr/local/bin/bwrap"));

async function makeWorktreeSession(worktree: string, agentDir: string) {
  const result: WorktreeResult = {
    cwd: worktree,
    meta: { repo: path.dirname(worktree), branch: "pi/test-session-id" },
  };
  const sessionFile = await run(setupNewSession(result, agentDir));
  return { sessionFile, meta: result.meta, cwd: result.cwd };
}

/** Append a fake user message to a session file to act as a sentinel. */
function appendSentinel(sessionFile: string, id = "sentinel-001") {
  const line = JSON.stringify({
    type: "user",
    id,
    timestamp: new Date().toISOString(),
    content: [{ type: "text", text: `sentinel message ${id}` }],
    parentId: null,
  });
  fs.appendFileSync(sessionFile, line + "\n");
  return id;
}

// ── 1. launchEffect passes --session to main() ────────────────────────────────

describe("launchEffect non-sandbox: passes --session to main()", () => {
  let savedCwd: string;
  beforeEach(() => {
    mockMain.mockClear();
    mockSpawnSync.mockClear();
    mockMain.mockResolvedValue(undefined);
    savedCwd = process.cwd();
  });
  // Restore cwd after each test — launchEffect calls process.chdir(cwd)
  // which would leave the process in a deleted temp dir, breaking later tests.
  afterEach(() => { try { process.chdir(savedCwd); } catch { /* ignore */ } });

  it("calls main() with --session <path> as the first two args", async () => {
    const { launchEffect } = await import("./launcher.ts");
    const cwd = makeTmp("pit-cwd-");
    const sessionFile = path.join(makeTmp("pit-sess-"), "session.jsonl");
    fs.writeFileSync(sessionFile, "{}");

    await Effect.runPromise(
      launchEffect(
        cwd,
        ["--session", sessionFile, "--append-system-prompt", "pit session"],
        false,  // no sandbox — goes to main() directly
      ).pipe(Effect.provide(NodeContext.layer))
    );

    expect(mockMain).toHaveBeenCalledOnce();
    const [calledArgv] = mockMain.mock.calls[0]!;
    expect(calledArgv[0]).toBe("--session");
    expect(calledArgv[1]).toBe(sessionFile);
  });

  it("main() receives the exact session path, not a different one", async () => {
    const { launchEffect } = await import("./launcher.ts");
    const cwd = makeTmp("pit-cwd-");
    const existingSession = path.join(makeTmp("pit-sess-"), "session.jsonl");
    const wrongSession   = path.join(makeTmp("pit-sess-"), "wrong.jsonl");
    fs.writeFileSync(existingSession, "{}");

    await Effect.runPromise(
      launchEffect(cwd, ["--session", existingSession], false).pipe(
        Effect.provide(NodeContext.layer)
      )
    );

    const [calledArgv] = mockMain.mock.calls[0]!;
    const idx = calledArgv.indexOf("--session");
    expect(idx).toBeGreaterThan(-1);
    expect(calledArgv[idx + 1]).toBe(existingSession);
    expect(calledArgv[idx + 1]).not.toBe(wrongSession);
  });

  it("does not add extra --session flags beyond what was passed", async () => {
    const { launchEffect } = await import("./launcher.ts");
    const cwd = makeTmp("pit-cwd-");
    const sessionFile = path.join(makeTmp("pit-sess-"), "session.jsonl");
    fs.writeFileSync(sessionFile, "{}");

    await Effect.runPromise(
      launchEffect(cwd, ["--session", sessionFile], false).pipe(
        Effect.provide(NodeContext.layer)
      )
    );

    const [calledArgv] = mockMain.mock.calls[0]!;
    const count = calledArgv.filter((a: string) => a === "--session").length;
    expect(count).toBe(1);
  });
});

// ── 2. bwrapLaunch: --session arg reaches inner.ts ────────────────────────────

describe("bwrapLaunch: --session arg reaches inner.ts argv", () => {
  beforeEach(() => { mockSpawnSync.mockClear(); });

  const launchWithSession = async (sessionFile: string) => {
    const { bwrapLaunch } = await import("./launcher.ts");
    const mounts = { ro: [{ path: "/etc" }], rw: [{ path: "/tmp" }] };
    const exitStub = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    bwrapLaunch("/tmp", ["--session", sessionFile, "--append-system-prompt", "x"], mounts, {});
    exitStub.mockRestore();
    return mockSpawnSync.mock.calls[0]![1] as string[];
  };

  it("includes --session <path> in inner.ts argv (after -- separator)", async () => {
    const sessionFile = "/tmp/fake-agent/sessions/bucket/session.jsonl";
    const args = await launchWithSession(sessionFile);
    const sep = args.indexOf("--");
    expect(sep).toBeGreaterThan(-1);
    const innerArgs = args.slice(sep + 1);
    expect(innerArgs).toContain("--session");
    expect(innerArgs[innerArgs.indexOf("--session") + 1]).toBe(sessionFile);
  });

  it("exec target is inner.ts, not the pi binary", async () => {
    const args = await launchWithSession("/tmp/s.jsonl");
    const sep = args.indexOf("--");
    const innerArgs = args.slice(sep + 1);
    // nodeBin, --experimental-strip-types, <target>, ...
    const execTarget = innerArgs[2];
    expect(execTarget).toMatch(/inner\.ts$/);
    expect(execTarget).not.toMatch(/\/pi$/);
  });

  it("--clearenv is present (no ambient credentials leak into sandbox)", async () => {
    const args = await launchWithSession("/tmp/s.jsonl");
    expect(args).toContain("--clearenv");
  });

  it("--session is NOT lost between bwrapLaunch piArgs and inner.ts argv", async () => {
    // Regression: if piArgs are dropped, inner pit calls main([]) and creates a new session
    const sessionFile = "/tmp/existing-session.jsonl";
    const args = await launchWithSession(sessionFile);
    const sep = args.indexOf("--");
    const innerArgs = args.slice(sep + 1);
    // inner.ts is at index 2, piArgs follow
    const passedToPit = innerArgs.slice(3); // after nodeBin, --strip-types, inner.ts
    expect(passedToPit).toContain("--session");
    expect(passedToPit).toContain(sessionFile);
  });
});

// ── 3. Session file accessible inside bwrap ───────────────────────────────────

describe("session file accessible inside bwrap", () => {
  it.skipIf(!hasBwrap)(
    "session file at agentDir real path is readable inside sandbox",
    async () => {
      const agentDir = makeSandbox("pit-agent-");
      const worktree  = makeSandbox("pit-wt-");
      const { sessionFile } = await makeWorktreeSession(worktree, agentDir);
      appendSentinel(sessionFile);

      const nodeBin = process.execPath;
      const nodeDir = path.dirname(path.dirname(nodeBin));
      const bwrap   = findBwrapReal()!;

      const result = spawnSync(
        bwrap,
        [
          "--tmpfs", "/",
          "--dev",   "/dev",
          "--proc",  "/proc",
          "--ro-bind", "/usr", "/usr",
          "--ro-bind", "/etc", "/etc",
          "--ro-bind-try", "/mnt/wsl", "/mnt/wsl",
          "--ro-bind-try", "/lib",   "/lib",
          "--ro-bind-try", "/lib64", "/lib64",
          "--ro-bind-try", "/bin",   "/bin",
          "--ro-bind-try", "/sbin",  "/sbin",
          "--bind", worktree,  worktree,
          // Pit mounts agentDirReal at its real path AND as /pit-agent
          "--bind", agentDir, agentDir,
          "--bind", agentDir, "/pit-agent",
          "--unshare-user",
          "--unshare-pid",
          "--die-with-parent",
          "--setenv", "HOME",   process.env.HOME!,
          "--setenv", "PATH",   "/usr/bin:/bin",
          "--setenv", "PI_CODING_AGENT_DIR", "/pit-agent",
          "--chdir", worktree,
          "--",
          // Use grep (from /usr/bin) rather than node to keep the test minimal
          "/usr/bin/grep", "-c", "sentinel-001", sessionFile,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 8000 }
      );

      // grep exits 0 if it found matches, 1 if no matches, 2 on error
      expect(
        result.status,
        `session file not accessible or sentinel missing inside bwrap.\nstderr: ${result.stderr}`
      ).toBe(0);
    }
  );
});

// ── 4. Existing session content survives resume ───────────────────────────────

describe("pit -r: existing session content is preserved", () => {
  it("SessionManager.open returns sentinel entry, not a blank session", async () => {
    const agentDir = makeTmp("pit-agent-");
    const worktree  = makeTmp("pit-wt-");
    const { sessionFile } = await makeWorktreeSession(worktree, agentDir);
    const sentinelId = appendSentinel(sessionFile);
    const linesBefore = fs.readFileSync(sessionFile, "utf8").trim().split("\n").length;

    const sm = SessionManager.open(sessionFile);
    const sentinel = sm.getEntries().find((e: any) => e.id === sentinelId);

    expect(sentinel).toBeDefined();
    // Opening must NOT write new lines (which would signal a blank session was created)
    const linesAfter = fs.readFileSync(sessionFile, "utf8").trim().split("\n").length;
    expect(linesAfter).toBe(linesBefore);
  });

  it("opening the same path twice does not grow the file", async () => {
    const agentDir = makeTmp("pit-agent-");
    const worktree  = makeTmp("pit-wt-");
    const { sessionFile } = await makeWorktreeSession(worktree, agentDir);
    appendSentinel(sessionFile);

    const linesBefore = fs.readFileSync(sessionFile, "utf8").trim().split("\n").length;
    SessionManager.open(sessionFile);
    SessionManager.open(sessionFile);
    expect(fs.readFileSync(sessionFile, "utf8").trim().split("\n").length).toBe(linesBefore);
  });

  it("session cwd stored in header equals the worktree path", async () => {
    const agentDir = makeTmp("pit-agent-");
    const worktree  = makeTmp("pit-wt-");
    const { sessionFile, cwd } = await makeWorktreeSession(worktree, agentDir);

    const sm = SessionManager.open(sessionFile);
    expect(sm.getCwd()).toBe(cwd);
  });

  it("session cwd exists inside bwrap (does not trigger getMissingSessionCwdIssue)", async () => {
    // getMissingSessionCwdIssue checks existsSync(sessionCwd) inside pi.
    // If the cwd is the worktree and the worktree IS mounted, it returns undefined → no issue.
    // If it returns an issue, in non-interactive mode pi exits(1) and the user sees nothing.
    const agentDir = makeTmp("pit-agent-");
    const worktree  = makeTmp("pit-wt-");
    const { sessionFile } = await makeWorktreeSession(worktree, agentDir);

    const sm = SessionManager.open(sessionFile);
    const sessionCwd = sm.getCwd();
    expect(sessionCwd).toBeDefined();
    // The worktree directory itself must exist (it's the makeTmp dir)
    expect(fs.existsSync(sessionCwd!)).toBe(true);
  });
});

// ── 5. Handoff compatibility: session header cwd is authoritative ─────────────
//
// /handoff updates the session header's cwd but leaves pit metadata unchanged.
// worktreeCheckEffect must use the session header cwd (passed as existing.cwd),
// not any stale worktree field that old session files may carry.

describe("worktreeCheckEffect: uses session header cwd, not stale pit metadata", () => {
  /**
   * Build a session file that looks like a post-handoff session:
   *   - header cwd = handoffTarget (the directory the session was moved to)
   *   - pit CustomEntry worktree = originalCwd (stale, as left by the old code)
   *
   * This mirrors the real artifact produced by /handoff on sessions created
   * before the worktree field was removed from PitMetadata.
   */
  function writeHandoffSession(
    sessionFile: string,
    originalCwd: string,
    handoffTarget: string,
  ): void {
    const header = {
      type: "session", version: CURRENT_SESSION_VERSION,
      id: "handoff-test-id", timestamp: new Date().toISOString(),
      cwd: handoffTarget,  // updated by /handoff
    };
    // Old-format pit entry: still has the stale worktree field
    const pitEntry = {
      type: "custom", id: "pit-entry-id", parentId: null,
      timestamp: new Date().toISOString(), customType: "pit",
      data: {
        id: "abc12345", repo: originalCwd,
        worktree: originalCwd,  // stale — handoff didn't update this
        branch: "", created: new Date().toISOString(),
        mode: "no-tree", noTreeReason: "no-repo",
      },
    };
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, [header, pitEntry].map(e => JSON.stringify(e)).join("\n") + "\n");
  }

  it("returns the session header cwd, not the stale meta worktree", async () => {
    const originalCwd  = makeTmp("handoff-src-");
    const handoffTarget = makeTmp("handoff-dst-");
    const sessionFile  = path.join(makeTmp("handoff-sess-"), "session.jsonl");
    writeHandoffSession(sessionFile, originalCwd, handoffTarget);

    const sm = SessionManager.open(sessionFile);
    const pitEntry = sm.getEntries().find(
      (e) => e.type === "custom" && (e as { customType?: string }).customType === "pit",
    ) as { data: Record<string, unknown> } | undefined;

    // The stale fields are present in the raw JSON (old session compat)
    expect(pitEntry?.data["mode"]).toBe("no-tree");
    expect(pitEntry?.data["worktree"]).toBe(originalCwd);
    // But worktreeCheckEffect must use the session header cwd, not the stale worktree
    const result = await Effect.runPromise(
      worktreeCheckEffect({ meta: pitEntry!.data as unknown as ExistingSession["meta"], cwd: sm.getCwd()! })
        .pipe(Effect.provide(NodeContext.layer)),
    );
    expect(result.cwd).toBe(handoffTarget);
    expect(result.cwd).not.toBe(originalCwd);
  });

  it("no-tree: does not attempt git operations when cwd exists", async () => {
    // worktreeCheckEffect(no-tree) must return immediately with the given cwd.
    // If it accidentally used the stale worktree field and tried to recreate
    // a git worktree, it would fail (no repo). This test confirms it does not.
    const originalCwd  = makeTmp("handoff-src-");
    const handoffTarget = makeTmp("handoff-dst-");
    const sessionFile  = path.join(makeTmp("handoff-sess-"), "session.jsonl");
    writeHandoffSession(sessionFile, originalCwd, handoffTarget);

    const sm = SessionManager.open(sessionFile);
    const pitEntry = sm.getEntries().find(
      (e) => e.type === "custom" && (e as { customType?: string }).customType === "pit",
    ) as { data: ExistingSession["meta"] } | undefined;

    // Must not throw even though neither dir is a git repo
    await expect(
      Effect.runPromise(
        worktreeCheckEffect({ meta: pitEntry!.data, cwd: sm.getCwd()! })
          .pipe(Effect.provide(NodeContext.layer)),
      ),
    ).resolves.toMatchObject({ cwd: handoffTarget });
  });
});

// ── 6. worktreeCheckEffect — new branch/no-tree logic ─────────────────────────
//
// Tests for the new metadata design where:
//   branch === "" → no-tree (no recovery possible when dir is gone)
//   branch !== "" → worktree (recovery attempted when dir is missing)
//   mode is no longer stored; dir existence + git state are authoritative

// Note: makeGitRepo and git-dependent worktreeCheckEffect tests live in
// pit/tests/worktree-check.test.ts where spawnSync is not mocked.

describe("worktreeCheckEffect — branch-based no-tree detection", () => {

  // ── directory exists (no git needed) ────────────────────────────────────────

  it("dir exists + branch non-empty: returns cwd immediately, no git ops", async () => {
    const cwd = makeTmp("wc-existing-");
    const meta = { repo: "/irrelevant/repo", branch: "pi/abc12345" };
    const result = await Effect.runPromise(
      worktreeCheckEffect({ meta, cwd }).pipe(Effect.provide(NodeContext.layer)),
    );
    expect(result.cwd).toBe(cwd);
    expect(result.meta).toEqual(meta);
  });

  it("dir exists + branch empty: returns cwd immediately, no git ops", async () => {
    const cwd = makeTmp("wc-notree-");
    const meta = { repo: cwd, branch: "" };
    const result = await Effect.runPromise(
      worktreeCheckEffect({ meta, cwd }).pipe(Effect.provide(NodeContext.layer)),
    );
    expect(result.cwd).toBe(cwd);
    expect(result.meta).toEqual(meta);
  });

  // ── directory missing, no-tree (no git needed) ───────────────────────────────

  it("dir missing + branch empty: no recreation, returns cwd as-is", async () => {
    const cwd = makeTmp("wc-gone-") + "-does-not-exist";
    const meta = { repo: cwd, branch: "" };
    // Must not throw WorktreeMissingError or WorktreeCreationError
    const result = await Effect.runPromise(
      worktreeCheckEffect({ meta, cwd }).pipe(Effect.provide(NodeContext.layer)),
    );
    expect(result.cwd).toBe(cwd);
  });

  // ── git-dependent cases: see pit/tests/worktree-check.test.ts ──────────────

  it.todo("dir missing + branch exists: recreates worktree");
  it.todo("dir missing + branch deleted: throws WorktreeMissingError");
});
// ── 7. New session path — metadata shape ───────────────────────────────────────
//
// Verifies that sessions created without an existing session produce
// the correct PitMetadata shape (branch: "" for no-tree, no extra fields).

// Note: git-dependent new session tests live in pit/tests/worktree-check.test.ts.
// Here we only test the metadata shape guarantee that requires no real git.

describe("new session metadata shape (worktreeCheckEffect with no existing)", () => {
  let savedCwd: string;
  beforeEach(() => { savedCwd = process.cwd(); });
  afterEach(() => { try { process.chdir(savedCwd); } catch { /* ignore */ } });

  it("no-tree (no git repo): meta has branch \'\' and repo === cwd", async () => {
    const cwd = makeTmp("notree-cwd-");
    process.chdir(cwd);
    const result = await Effect.runPromise(
      worktreeCheckEffect(undefined, false).pipe(Effect.provide(NodeContext.layer)),
    );
    expect(result.meta.branch).toBe("");
    expect(result.meta.repo).toBe(cwd);
  });

  it("no-tree: meta stores no mode, id, created, or noTreeReason fields", async () => {
    const cwd = makeTmp("notree-fields-");
    process.chdir(cwd);
    const result = await Effect.runPromise(
      worktreeCheckEffect(undefined, false).pipe(Effect.provide(NodeContext.layer)),
    );
    const raw = result.meta as unknown as Record<string, unknown>;
    expect(raw["mode"]).toBeUndefined();
    expect(raw["id"]).toBeUndefined();
    expect(raw["created"]).toBeUndefined();
    expect(raw["noTreeReason"]).toBeUndefined();
  });

  // git-dependent (require real git init — see pit/tests/worktree-check.test.ts)
  it.todo("no-tree forced (git repo + forceNoTree): repo === git root");
  it.todo("new worktree: branch stored in metadata, cwd is worktree path");
});
// ── 8. showPicker CWD fix: session UUID and cwd from header ───────────────────
//
// Verifies the underlying invariants that the showPicker fix relies on.
// showPicker now uses sm.getCwd() and sm.getSessionId() — these must be
// readable from session files regardless of whether a pit entry exists.

describe("showPicker invariants: cwd and UUID readable from session header", () => {

  it("session without pit entry: getCwd() returns the header cwd", async () => {
    const agentDir = makeTmp("picker-agent-");
    const cwd = makeTmp("picker-cwd-");
    // Write a session with NO pit entry — just the header
    const bucket = "--" + cwd.replace(/^\//, "").replace(/\//g, "-") + "--";
    const dir = path.join(agentDir, "sessions", bucket);
    fs.mkdirSync(dir, { recursive: true });
    const sessionId = "picker-test-uuid-1234";
    const sessionFile = path.join(dir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
    fs.writeFileSync(sessionFile,
      JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION,
        id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd }) + "\n",
    );

    const sm = SessionManager.open(sessionFile);
    // getCwd() must return the session's own cwd, not process.cwd()
    expect(sm.getCwd()).toBe(cwd);
  });

  it("session UUID from getSessionId() matches the header id field", async () => {
    const agentDir = makeTmp("picker-agent-");
    const { sessionFile } = await makeWorktreeSession(makeTmp("picker-wt-"), agentDir);
    const sm = SessionManager.open(sessionFile);
    const header = JSON.parse(fs.readFileSync(sessionFile, "utf8").split("\n")[0]);
    expect(sm.getSessionId()).toBe(header.id);
  });

  it("session with pit entry: getCwd() still returns the header cwd (not from meta)", async () => {
    const agentDir = makeTmp("picker-agent-");
    const cwd = makeTmp("picker-cwd-");
    const { sessionFile } = await makeWorktreeSession(cwd, agentDir);
    const sm = SessionManager.open(sessionFile);
    expect(sm.getCwd()).toBe(cwd);
  });
});

// ── 9. Backward compat: old-format session metadata ───────────────────────────
//
// Old sessions carry extra fields (id, mode, noTreeReason, created, worktree).
// New code reads only repo and branch — extra fields must be silently ignored.

describe("backward compat: old-format session metadata", () => {

  function writeOldFormatSession(sessionFile: string, cwd: string): void {
    const header = { type: "session", version: CURRENT_SESSION_VERSION,
      id: "old-session-uuid", timestamp: "2026-01-01T00:00:00.000Z", cwd };
    const pitEntry = {
      type: "custom", id: "old-pit-id", parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z", customType: "pit",
      data: {
        id: "deadbeef",
        repo: cwd,
        worktree: cwd,
        branch: "pi/deadbeef",
        created: "2026-01-01T00:00:00.000Z",
        mode: "worktree",
        noTreeReason: undefined,
      },
    };
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, [header, pitEntry].map(e => JSON.stringify(e)).join("\n") + "\n");
  }

  it("repo and branch readable from old-format session", () => {
    const cwd = makeTmp("compat-cwd-");
    const sessionFile = path.join(makeTmp("compat-sess-"), "session.jsonl");
    writeOldFormatSession(sessionFile, cwd);

    const sm = SessionManager.open(sessionFile);
    const pitEntry = sm.getEntries().find(
      (e) => e.type === "custom" && (e as { customType?: string }).customType === "pit",
    ) as { data: { repo?: string; branch?: string } } | undefined;

    expect(pitEntry?.data.repo).toBe(cwd);
    expect(pitEntry?.data.branch).toBe("pi/deadbeef");
  });

  it("worktreeCheckEffect handles old-format session: uses ExistingSession cwd, ignores worktree field", async () => {
    const cwd = makeTmp("compat-dir-");
    const sessionFile = path.join(makeTmp("compat-sess-"), "session.jsonl");
    writeOldFormatSession(sessionFile, cwd);

    const sm = SessionManager.open(sessionFile);
    const pitEntry = sm.getEntries().find(
      (e) => e.type === "custom" && (e as { customType?: string }).customType === "pit",
    ) as { data: Record<string, unknown> } | undefined;

    const result = await Effect.runPromise(
      worktreeCheckEffect({
        meta: pitEntry!.data as unknown as ExistingSession["meta"],
        cwd: sm.getCwd()!,
      }).pipe(Effect.provide(NodeContext.layer)),
    );
    // Must use the session header cwd, not the stale worktree field
    expect(result.cwd).toBe(cwd);
  });

  it("old id/mode/created fields are ignored — only repo and branch are used", () => {
    const cwd = makeTmp("compat-fields-");
    const sessionFile = path.join(makeTmp("compat-sess-"), "session.jsonl");
    writeOldFormatSession(sessionFile, cwd);

    const sm = SessionManager.open(sessionFile);
    const pitEntry = sm.getEntries().find(
      (e) => e.type === "custom" && (e as { customType?: string }).customType === "pit",
    ) as { data: Record<string, unknown> } | undefined;

    // The old fields are present in raw JSON but new code doesn't depend on them
    expect(pitEntry?.data["id"]).toBe("deadbeef");   // present in JSON
    expect(pitEntry?.data["mode"]).toBe("worktree"); // present in JSON
    // New code reads only these:
    expect(pitEntry?.data["repo"]).toBe(cwd);
    expect(pitEntry?.data["branch"]).toBe("pi/deadbeef");
  });
});
