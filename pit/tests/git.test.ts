/**
 * Tests for bundled/git.ts — git tool and /merge command.
 *
 * Strategy: mock the ExtensionAPI surface and a local Unix socket server
 * that plays the role of pit-escape. Each test controls what the mock
 * returns per-op, so the full /merge workflow can be driven without any
 * real git repo, bwrap, or pit-escape process.
 *
 * Unlike reload.test.ts (which always returns the same response and can
 * reply before reading the request), the /merge handler makes sequential
 * calls with different ops so the mock reads each request before replying.
 *
 * Key regression tested:
 *   Phase 2 of /merge previously sent { args: ["merge", parentBranch] }
 *   (the old git-helper.ts protocol). pit-escape requires { op: "git", args }
 *   and returns "request must have op (string)" for bare args objects —
 *   producing "Forward merge failed" whenever the worktree was behind the
 *   parent branch.
 *
 * What's under test:
 *   git tool:
 *     - Registers when PIT_ESCAPE_SOCKET is set; inert when unset
 *     - Sends { op: "git", args } to socket
 *     - Returns combined stdout+stderr on success
 *     - isError true when exit code != 0
 *     - isError true when pit-escape returns an error object
 *   /merge:
 *     - Phase 1: merge in progress with conflicts → user message
 *     - Phase 1: merge in progress, no conflicts → notify commit first
 *     - Phase 2 regression: forward merge sends { op: "git" }, not bare { args }
 *     - Phase 2: success → continues to phase 3
 *     - Phase 2: failure with conflicts → user message, stops
 *     - Phase 2: failure without conflicts → error notify, stops
 *     - Phase 3: success → success notify
 *     - Phase 3: failure → error notify
 *     - No parentBranch detected → error notify
 *     - Explicit args override detected parentBranch
 */

import { fileURLToPath } from "node:url";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import gitExt from "../extensions/tools/git.ts";
import mergeExt from "../extensions/commands/merge.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

const TEST_SANDBOX = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "test-sandbox"
);

type Req  = Record<string, unknown>;
type Resp = Record<string, unknown>;

/**
 * Start a mock socket server that plays the role of pit-escape.
 * Reads the newline-terminated JSON request, calls respond(), sends the result.
 * Unlike the reload mock, this reads before replying so dynamic responses work.
 */
function startMockEscape(socketPath: string, respond: (req: Req) => Resp) {
  const received: Req[] = [];
  const server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      buf = "";
      try {
        const req = JSON.parse(line) as Req;
        received.push(req);
        socket.end(JSON.stringify(respond(req)) + "\n");
      } catch {
        socket.end(JSON.stringify({ error: "parse error" }) + "\n");
      }
    });
    socket.on("error", () => { /* ignore client disconnect errors */ });
  });
  server.listen(socketPath);
  return { received, server };
}

const servers: net.Server[] = [];
const socketPaths: string[] = [];

beforeEach(() => { fs.mkdirSync(TEST_SANDBOX, { recursive: true }); });

afterEach(async () => {
  delete process.env.PIT_ESCAPE_SOCKET;
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  servers.length = 0;
  for (const p of socketPaths) { try { fs.unlinkSync(p); } catch { /* gone */ } }
  socketPaths.length = 0;
});

function makeSocketPath(): string {
  const p = path.join(
    TEST_SANDBOX,
    `mock-git-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`
  );
  socketPaths.push(p);
  return p;
}

// ── mock ExtensionAPI ─────────────────────────────────────────────────────────

type Notification = { msg: string; type: string };
type MockCtx = { waitForIdle: () => Promise<void>; ui: { notify: (m: string, t: string) => void } };

function makeMockPi() {
  type CmdHandler = (args: string, ctx: MockCtx) => Promise<void>;
  type ToolDef    = { name: string; execute: (id: string, p: { args: string[] }, s: unknown) => Promise<unknown> };

  const commands = new Map<string, CmdHandler>();
  const tools    = new Map<string, ToolDef>();
  const userMessages: string[] = [];

  const api = {
    registerCommand(name: string, opts: { description: string; handler: CmdHandler }) {
      commands.set(name, opts.handler);
    },
    registerTool(opts: ToolDef) {
      tools.set(opts.name, opts);
    },
    sendUserMessage(msg: string) { userMessages.push(msg); },

    // ── test helpers ───────────────────────────────────────────────────────
    hasMerge()     { return commands.has("merge"); },
    hasGitTool()   { return tools.has("git"); },
    userMessages,

    async runMerge(args = "", notifications: Notification[] = []) {
      const handler = commands.get("merge");
      if (!handler) throw new Error("merge command not registered");
      const ctx: MockCtx = {
        waitForIdle: () => Promise.resolve(),
        ui: { notify: (msg, type) => notifications.push({ msg, type }) },
      };
      await handler(args, ctx);
    },

    async runGitTool(args: string[]) {
      const tool = tools.get("git");
      if (!tool) throw new Error("git tool not registered");
      return tool.execute("id", { args }, {});
    },
  };

  return api;
}

// ── common state shapes ───────────────────────────────────────────────────────

const cleanState = {
  branch: "pi/abc123",
  mergeInProgress: false,
  conflicts: [] as string[],
  parentBranch: "master",
  behindParent: false,
};

const ok   = (stdout = "")  => ({ stdout, stderr: "", code: 0 });
const fail = (stderr = "")  => ({ stdout: "", stderr, code: 1 });

// ── git tool ──────────────────────────────────────────────────────────────────

describe("git tool registration", () => {
  it("registers the git tool when PIT_ESCAPE_SOCKET is set", () => {
    const socketPath = makeSocketPath();
    const { server } = startMockEscape(socketPath, () => ok());
    servers.push(server);

    process.env.PIT_ESCAPE_SOCKET = socketPath;
    const pi = makeMockPi();
    gitExt(pi as never); mergeExt(pi as never);

    expect(pi.hasGitTool()).toBe(true);
  });

  it("does NOT register the git tool when PIT_ESCAPE_SOCKET is unset", () => {
    delete process.env.PIT_ESCAPE_SOCKET;
    const pi = makeMockPi();
    gitExt(pi as never); mergeExt(pi as never);
    expect(pi.hasGitTool()).toBe(false);
  });
});

describe("git tool execution", () => {
  it("sends { op: 'git', args } to the socket", async () => {
    const socketPath = makeSocketPath();
    const { received, server } = startMockEscape(socketPath, () => ok("On branch pi/abc123"));
    servers.push(server);

    process.env.PIT_ESCAPE_SOCKET = socketPath;
    const pi = makeMockPi();
    gitExt(pi as never); mergeExt(pi as never);

    await pi.runGitTool(["status"]);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ op: "git", args: ["status"] });
  });

  it("returns stdout in the result content", async () => {
    const socketPath = makeSocketPath();
    const { server } = startMockEscape(socketPath, () => ok("On branch pi/abc123\nnothing to commit"));
    servers.push(server);

    process.env.PIT_ESCAPE_SOCKET = socketPath;
    const pi = makeMockPi();
    gitExt(pi as never); mergeExt(pi as never);

    const result = await pi.runGitTool(["status"]) as { content: { text: string }[]; isError: boolean };
    expect(result.content[0].text).toContain("On branch pi/abc123");
    expect(result.isError).toBe(false);
  });

  it("isError true when exit code is non-zero", async () => {
    const socketPath = makeSocketPath();
    const { server } = startMockEscape(socketPath, () => fail("not a git repository"));
    servers.push(server);

    process.env.PIT_ESCAPE_SOCKET = socketPath;
    const pi = makeMockPi();
    gitExt(pi as never); mergeExt(pi as never);

    const result = await pi.runGitTool(["status"]) as { isError: boolean };
    expect(result.isError).toBe(true);
  });

  it("isError true when pit-escape returns an error object", async () => {
    const socketPath = makeSocketPath();
    const { server } = startMockEscape(socketPath, () => ({ error: "git add: not permitted" }));
    servers.push(server);

    process.env.PIT_ESCAPE_SOCKET = socketPath;
    const pi = makeMockPi();
    gitExt(pi as never); mergeExt(pi as never);

    const result = await pi.runGitTool(["add", "."]) as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not permitted");
  });
});

// ── /merge registration ───────────────────────────────────────────────────────

describe("/merge registration", () => {
  it("registers the merge command when PIT_ESCAPE_SOCKET is set", () => {
    const socketPath = makeSocketPath();
    const { server } = startMockEscape(socketPath, () => cleanState);
    servers.push(server);

    process.env.PIT_ESCAPE_SOCKET = socketPath;
    const pi = makeMockPi();
    gitExt(pi as never); mergeExt(pi as never);

    expect(pi.hasMerge()).toBe(true);
  });

  it("does NOT register /merge when PIT_ESCAPE_SOCKET is unset", () => {
    delete process.env.PIT_ESCAPE_SOCKET;
    const pi = makeMockPi();
    gitExt(pi as never); mergeExt(pi as never);
    expect(pi.hasMerge()).toBe(false);
  });
});

// ── /merge phase 1: merge already in progress ─────────────────────────────────

describe("/merge phase 1 — merge in progress", () => {
  it("sends a user message listing the conflicted files", async () => {
    const socketPath = makeSocketPath();
    const { server } = startMockEscape(socketPath, () => ({
      ...cleanState,
      mergeInProgress: true,
      conflicts: ["src/foo.ts", "src/bar.ts"],
    }));
    servers.push(server);

    process.env.PIT_ESCAPE_SOCKET = socketPath;
    const pi = makeMockPi();
    gitExt(pi as never); mergeExt(pi as never);

    await pi.runMerge();

    expect(pi.userMessages).toHaveLength(1);
    expect(pi.userMessages[0]).toContain("src/foo.ts");
    expect(pi.userMessages[0]).toContain("src/bar.ts");
  });

  it("notifies 'warning' when conflicts exist", async () => {
    const socketPath = makeSocketPath();
    const { server } = startMockEscape(socketPath, () => ({
      ...cleanState, mergeInProgress: true, conflicts: ["a.ts"],
    }));
    servers.push(server);

    process.env.PIT_ESCAPE_SOCKET = socketPath;
    const pi = makeMockPi();
    gitExt(pi as never); mergeExt(pi as never);

    const notifications: Notification[] = [];
    await pi.runMerge("", notifications);

    expect(notifications.some((n) => n.type === "warning")).toBe(true);
  });

  it("notifies 'info' when merge is in progress but clean (no conflicts)", async () => {
    const socketPath = makeSocketPath();
    const { server } = startMockEscape(socketPath, () => ({
      ...cleanState, mergeInProgress: true, conflicts: [],
    }));
    servers.push(server);

    process.env.PIT_ESCAPE_SOCKET = socketPath;
    const pi = makeMockPi();
    gitExt(pi as never); mergeExt(pi as never);

    const notifications: Notification[] = [];
    await pi.runMerge("", notifications);

    expect(pi.userMessages).toHaveLength(0);
    expect(notifications.some((n) => n.type === "info")).toBe(true);
  });

  it("stops after phase 1 — does not send merge-to-parent", async () => {
    const socketPath = makeSocketPath();
    const { received, server } = startMockEscape(socketPath, () => ({
      ...cleanState, mergeInProgress: true, conflicts: ["a.ts"],
    }));
    servers.push(server);

    process.env.PIT_ESCAPE_SOCKET = socketPath;
    const pi = makeMockPi();
    gitExt(pi as never); mergeExt(pi as never);

    await pi.runMerge();

    const ops = received.map((r) => r.op);
    expect(ops).not.toContain("merge-to-parent");
  });
});

// ── /merge phase 2: worktree behind parent ────────────────────────────────────

describe("/merge phase 2 — worktree behind parent", () => {
  it("sends { op: 'git', args: ['merge', parentBranch] } — not bare { args } (regression)", async () => {
    // Before the fix, phase 2 sent { args: ["merge", parentBranch] } (old git-helper
    // protocol). pit-escape requires op to be present and returned
    // "request must have op (string)", causing "Forward merge failed".
    const socketPath = makeSocketPath();
    const { received, server } = startMockEscape(socketPath, (req) => {
      if (req.op === "get-state") return { ...cleanState, behindParent: true };
      if (req.op === "git")            return ok("Already up to date.");
      if (req.op === "merge-to-parent") return ok("Fast-forward");
      return { error: `unexpected op: ${String(req.op)}` };
    });
    servers.push(server);

    process.env.PIT_ESCAPE_SOCKET = socketPath;
    const pi = makeMockPi();
    gitExt(pi as never); mergeExt(pi as never);

    await pi.runMerge();

    const fwdReq = received.find((r) => r.op === "git");
    expect(fwdReq, "phase 2 must send op: 'git'").toBeDefined();
    expect(fwdReq!.args).toEqual(["merge", "master"]);
  });

  it("continues to phase 3 when forward merge succeeds", async () => {
    const socketPath = makeSocketPath();
    const { received, server } = startMockEscape(socketPath, (req) => {
      if (req.op === "get-state")       return { ...cleanState, behindParent: true };
      if (req.op === "git")              return ok("Merge made.");
      if (req.op === "merge-to-parent") return ok("Fast-forward");
      return { error: `unexpected op: ${String(req.op)}` };
    });
    servers.push(server);

    process.env.PIT_ESCAPE_SOCKET = socketPath;
    const pi = makeMockPi();
    gitExt(pi as never); mergeExt(pi as never);

    const notifications: Notification[] = [];
    await pi.runMerge("", notifications);

    expect(received.some((r) => r.op === "merge-to-parent")).toBe(true);
    expect(notifications.some((n) => n.msg.includes("✓"))).toBe(true);
  });

  it("sends user message and stops when forward merge creates conflicts", async () => {
    const socketPath = makeSocketPath();
    let getStateCallCount = 0;
    const { received, server } = startMockEscape(socketPath, (req) => {
      if (req.op === "get-state") {
        getStateCallCount++;
        // First call: behind parent. Second call (after failed merge): conflicts.
        return getStateCallCount === 1
          ? { ...cleanState, behindParent: true }
          : { ...cleanState, mergeInProgress: true, conflicts: ["conflict.ts"] };
      }
      if (req.op === "git") return fail("CONFLICT");
      return { error: `unexpected op: ${String(req.op)}` };
    });
    servers.push(server);

    process.env.PIT_ESCAPE_SOCKET = socketPath;
    const pi = makeMockPi();
    gitExt(pi as never); mergeExt(pi as never);

    const notifications: Notification[] = [];
    await pi.runMerge("", notifications);

    expect(pi.userMessages[0]).toContain("conflict.ts");
    expect(notifications.some((n) => n.type === "warning")).toBe(true);
    expect(received.some((r) => r.op === "merge-to-parent")).toBe(false);
  });

  it("notifies error and stops when forward merge fails without conflicts", async () => {
    const socketPath = makeSocketPath();
    let getStateCallCount = 0;
    const { received, server } = startMockEscape(socketPath, (req) => {
      if (req.op === "get-state") {
        getStateCallCount++;
        return getStateCallCount === 1
          ? { ...cleanState, behindParent: true }
          : { ...cleanState, mergeInProgress: false, conflicts: [] };
      }
      if (req.op === "git") return fail("unrelated error");
      return { error: `unexpected op: ${String(req.op)}` };
    });
    servers.push(server);

    process.env.PIT_ESCAPE_SOCKET = socketPath;
    const pi = makeMockPi();
    gitExt(pi as never); mergeExt(pi as never);

    const notifications: Notification[] = [];
    await pi.runMerge("", notifications);

    expect(notifications.some((n) => n.type === "error")).toBe(true);
    expect(received.some((r) => r.op === "merge-to-parent")).toBe(false);
  });
});

// ── /merge phase 3: fast-forward to parent ────────────────────────────────────

describe("/merge phase 3 — fast-forward", () => {
  it("sends { op: 'merge-to-parent', parentBranch }", async () => {
    const socketPath = makeSocketPath();
    const { received, server } = startMockEscape(socketPath, (req) => {
      if (req.op === "get-state")       return cleanState;
      if (req.op === "merge-to-parent") return ok("Fast-forward");
      return { error: `unexpected op: ${String(req.op)}` };
    });
    servers.push(server);

    process.env.PIT_ESCAPE_SOCKET = socketPath;
    const pi = makeMockPi();
    gitExt(pi as never); mergeExt(pi as never);

    await pi.runMerge();

    const req = received.find((r) => r.op === "merge-to-parent");
    expect(req).toBeDefined();
    expect(req!.parentBranch).toBe("master");
  });

  it("notifies success when fast-forward succeeds", async () => {
    const socketPath = makeSocketPath();
    const { server } = startMockEscape(socketPath, (req) => {
      if (req.op === "get-state")       return cleanState;
      if (req.op === "merge-to-parent") return ok("Fast-forward");
      return { error: `unexpected op: ${String(req.op)}` };
    });
    servers.push(server);

    process.env.PIT_ESCAPE_SOCKET = socketPath;
    const pi = makeMockPi();
    gitExt(pi as never); mergeExt(pi as never);

    const notifications: Notification[] = [];
    await pi.runMerge("", notifications);

    expect(notifications.some((n) => n.msg.includes("✓"))).toBe(true);
    expect(notifications.some((n) => n.type === "info")).toBe(true);
  });

  it("notifies error when fast-forward fails", async () => {
    const socketPath = makeSocketPath();
    const { server } = startMockEscape(socketPath, (req) => {
      if (req.op === "get-state")       return cleanState;
      if (req.op === "merge-to-parent") return fail("Not possible to fast-forward");
      return { error: `unexpected op: ${String(req.op)}` };
    });
    servers.push(server);

    process.env.PIT_ESCAPE_SOCKET = socketPath;
    const pi = makeMockPi();
    gitExt(pi as never); mergeExt(pi as never);

    const notifications: Notification[] = [];
    await pi.runMerge("", notifications);

    expect(notifications.some((n) => n.type === "error")).toBe(true);
  });
});

// ── /merge parent branch resolution ──────────────────────────────────────────

describe("/merge parent branch resolution", () => {
  it("uses parentBranch from state when no args provided", async () => {
    const socketPath = makeSocketPath();
    const { received, server } = startMockEscape(socketPath, (req) => {
      if (req.op === "get-state")       return { ...cleanState, parentBranch: "main" };
      if (req.op === "merge-to-parent") return ok();
      return { error: `unexpected op: ${String(req.op)}` };
    });
    servers.push(server);

    process.env.PIT_ESCAPE_SOCKET = socketPath;
    const pi = makeMockPi();
    gitExt(pi as never); mergeExt(pi as never);

    await pi.runMerge();

    const req = received.find((r) => r.op === "merge-to-parent");
    expect(req!.parentBranch).toBe("main");
  });

  it("explicit args override the detected parentBranch", async () => {
    const socketPath = makeSocketPath();
    const { received, server } = startMockEscape(socketPath, (req) => {
      if (req.op === "get-state")       return { ...cleanState, parentBranch: "master" };
      if (req.op === "merge-to-parent") return ok();
      return { error: `unexpected op: ${String(req.op)}` };
    });
    servers.push(server);

    process.env.PIT_ESCAPE_SOCKET = socketPath;
    const pi = makeMockPi();
    gitExt(pi as never); mergeExt(pi as never);

    await pi.runMerge("develop");

    const req = received.find((r) => r.op === "merge-to-parent");
    expect(req!.parentBranch).toBe("develop");
  });

  it("notifies error when no parentBranch in state and no args given", async () => {
    const socketPath = makeSocketPath();
    const { server } = startMockEscape(socketPath, () => ({
      ...cleanState, parentBranch: null,
    }));
    servers.push(server);

    process.env.PIT_ESCAPE_SOCKET = socketPath;
    const pi = makeMockPi();
    gitExt(pi as never); mergeExt(pi as never);

    const notifications: Notification[] = [];
    await pi.runMerge("", notifications);

    expect(notifications.some((n) => n.type === "error")).toBe(true);
  });
});
