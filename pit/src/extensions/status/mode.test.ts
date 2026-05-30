/**
 * Tests for the pit mode footer extension (createModeStatus).
 *
 * The extension reads live git state at session_start and sets two status keys:
 *   "pit-mode"    — "worktree: <branch>" | "no-tree"
 *   "pit-sandbox" — "sandbox" | "no sandbox"
 *
 * We mock the ExtensionAPI (just the `on` and `ui.setStatus` surface)
 * and control the git state via real temp dirs with fake .git files.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createModeStatus } from "./mode.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

function makeTmp(prefix = "mode-test-"): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

/** Write a fake .git file so isLinkedWorktree returns true for this dir. */
function makeLinkedWorktree(cwd: string, branch: string, mainRepo: string): void {
  const gitdir = path.join(mainRepo, ".git", "worktrees", "wt");
  fs.mkdirSync(gitdir, { recursive: true });
  // Write HEAD in the fake worktree gitdir
  fs.writeFileSync(path.join(gitdir, "HEAD"), `ref: refs/heads/${branch}\n`);
  // Write .git pointer in the worktree dir
  fs.writeFileSync(path.join(cwd, ".git"), `gitdir: ${gitdir}\n`);
}

/** Build a mock ExtensionAPI that captures on() handlers and setStatus calls. */
function makeMockApi() {
  const statuses: Record<string, string | undefined> = {};
  let sessionStartHandler: ((event: unknown, ctx: { cwd: string; ui: { setStatus: (k: string, v: string | undefined) => void } }) => Promise<void>) | undefined;

  const api = {
    on: vi.fn((event: string, handler: typeof sessionStartHandler) => {
      if (event === "session_start") sessionStartHandler = handler;
    }),
    ui: { setStatus: vi.fn((k: string, v: string | undefined) => { statuses[k] = v; }) },
  } as unknown as ExtensionAPI;

  const triggerSessionStart = async (cwd: string) => {
    await sessionStartHandler?.("session_start", {
      cwd,
      ui: { setStatus: (k: string, v: string | undefined) => { statuses[k] = v; } },
    });
  };

  return { api, statuses, triggerSessionStart };
}

// ── mode footer tests ─────────────────────────────────────────────────────────

describe("createModeStatus — pit-mode status key", () => {
  it("sets 'no-tree' for a plain directory (not a git worktree)", async () => {
    const cwd = makeTmp("notree-");
    const { api, statuses, triggerSessionStart } = makeMockApi();
    createModeStatus("")(api);
    await triggerSessionStart(cwd);
    expect(statuses["pit-mode"]).toBe("no-tree");
  });

  it("sets 'worktree: <branch>' for a linked worktree dir", async () => {
    const cwd = makeTmp("wt-");
    const mainRepo = makeTmp("repo-");
    makeLinkedWorktree(cwd, "pi/abc12345", mainRepo);

    const { api, statuses, triggerSessionStart } = makeMockApi();
    createModeStatus("")(api);
    await triggerSessionStart(cwd);
    expect(statuses["pit-mode"]).toBe("worktree: pi/abc12345");
  });

  it("sets 'worktree: ?' when branch cannot be read", async () => {
    const cwd = makeTmp("wt-nohead-");
    const mainRepo = makeTmp("repo-");
    // Write .git file but no HEAD in the gitdir
    const gitdir = path.join(mainRepo, ".git", "worktrees", "wt");
    fs.mkdirSync(gitdir, { recursive: true });
    fs.writeFileSync(path.join(cwd, ".git"), `gitdir: ${gitdir}\n`);
    // No HEAD file written

    const { api, statuses, triggerSessionStart } = makeMockApi();
    createModeStatus("")(api);
    await triggerSessionStart(cwd);
    expect(statuses["pit-mode"]).toBe("worktree: ?");
  });
});

describe("createModeStatus — pit-sandbox status key", () => {
  it("sets 'sandbox' when socketPath is non-empty", async () => {
    const cwd = makeTmp("sb-");
    const { api, statuses, triggerSessionStart } = makeMockApi();
    createModeStatus("/tmp/pit-test.sock")(api);
    await triggerSessionStart(cwd);
    expect(statuses["pit-sandbox"]).toBe("sandbox");
  });

  it("sets 'no sandbox' when socketPath is empty", async () => {
    const cwd = makeTmp("nosb-");
    const { api, statuses, triggerSessionStart } = makeMockApi();
    createModeStatus("")(api);
    await triggerSessionStart(cwd);
    expect(statuses["pit-sandbox"]).toBe("no sandbox");
  });

  it("always sets both status keys regardless of mode", async () => {
    const cwd = makeTmp("both-");
    const { api, statuses, triggerSessionStart } = makeMockApi();
    createModeStatus("/tmp/pit.sock")(api);
    await triggerSessionStart(cwd);
    expect("pit-mode" in statuses).toBe(true);
    expect("pit-sandbox" in statuses).toBe(true);
  });
});

describe("createModeStatus — extension registration", () => {
  it("registers a session_start handler", () => {
    const { api } = makeMockApi();
    createModeStatus("")(api);
    expect(api.on).toHaveBeenCalledWith("session_start", expect.any(Function));
  });

  it("mode status is derived from live git state, not stored metadata", async () => {
    // A plain dir (no .git) always reports no-tree regardless of what
    // metadata might say. The extension never reads session metadata.
    const cwd = makeTmp("live-");
    const { api, statuses, triggerSessionStart } = makeMockApi();
    createModeStatus("")(api);
    await triggerSessionStart(cwd);
    expect(statuses["pit-mode"]).toBe("no-tree");
  });
});
