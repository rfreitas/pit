/**
 * Tests for the /rename-branch bundled command.
 *
 * Strategy:
 *   - vi.mock @earendil-works/pi-ai  →  complete() returns preset responses
 *   - vi.mock ../git-utils.ts        →  readWorktreeBranch() returns preset branch
 *   - Unix socket server             →  stands in for pit-escape
 *
 * What's under test:
 *   - Command not registered when PIT_ESCAPE_SOCKET is unset
 *   - Command registered when PIT_ESCAPE_SOCKET is set
 *   - Git context path: get-state + log + diff used when branch has commits
 *   - Conversation fallback: getBranch() used when log is empty
 *   - Slug sanitisation and prefix preservation (pi/<slug>)
 *   - "Already named" short-circuit when newBranch === currentBranch
 *   - Success notification on rename
 *   - Error: model returns invalid JSON
 *   - Error: model returns empty slug
 *   - Error: pit-escape rename-branch fails
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

// ── mocks (hoisted) ───────────────────────────────────────────────────────────

vi.mock("@earendil-works/pi-ai", () => ({
  complete: vi.fn(),
}));

import { complete } from "@earendil-works/pi-ai";
import renameBranchExt from "../commands/rename-branch.ts";

// ── fixtures ──────────────────────────────────────────────────────────────────

const CURRENT_BRANCH = "pi/fd9b759f";

/**
 * Create a minimal linked-worktree filesystem fixture.
 * worktreeDir/.git  →  gitdir: <gitdir>
 * <gitdir>/HEAD     →  ref: refs/heads/pi/fd9b759f
 */
function setupWorktreeFixture(): { worktreeDir: string; gitdir: string; cleanup: () => void } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pit-rename-branch-test-"));
  const worktreeDir = path.join(base, "worktree");
  // Path must contain /.git/worktrees/ so readWorktreeBranch passes its check
  const gitdir = path.join(base, "repo", ".git", "worktrees", "test-id");
  fs.mkdirSync(worktreeDir);
  fs.mkdirSync(gitdir, { recursive: true });
  fs.writeFileSync(path.join(worktreeDir, ".git"), `gitdir: ${gitdir}\n`);
  fs.writeFileSync(path.join(gitdir, "HEAD"), `ref: refs/heads/${CURRENT_BRANCH}\n`);
  return { worktreeDir, gitdir, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

/** Minimal complete() response fixture with a given slug. */
function aiResponse(slug: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ slug }) }],
  };
}

/** Session entries fixture — two message turns. */
const CONVERSATION_ENTRIES = [
  { type: "message", message: { role: "user",      content: "Add branch renaming" } },
  { type: "message", message: { role: "assistant", content: "Sure, I'll implement that." } },
];

// ── helpers ───────────────────────────────────────────────────────────────────

const TEST_SANDBOX = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "test-sandbox"
);

type Notification = { message: string; level: string };

function makeMockPi() {
  const commands = new Map<string, { handler: Function }>();
  return {
    registerCommand(name: string, def: { handler: Function }) {
      commands.set(name, def);
    },
    getCommand: (name: string) => commands.get(name),
  };
}

function makeMockCtx(overrides: Record<string, unknown> = {}) {
  const notifications: Notification[] = [];
  return {
    notifications,
    sessionManager: { getBranch: vi.fn(() => CONVERSATION_ENTRIES) },
    model: "test-model",
    modelRegistry: {
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: true,
        apiKey: "test-key",
        headers: {},
      })),
    },
    ui: {
      notify: vi.fn((message: string, level: string) =>
        notifications.push({ message, level })
      ),
    },
    ...overrides,
  };
}

/**
 * Start a mock pit-escape socket server.
 * The handler receives each parsed request and returns the response object.
 */
function startMockEscape(
  socketPath: string,
  handler: (req: Record<string, unknown>) => object
) {
  const received: object[] = [];
  const server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const req = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
      received.push(req);
      socket.end(JSON.stringify(handler(req)) + "\n");
    });
    socket.on("error", () => {});
  });
  server.listen(socketPath);
  return { received, server };
}

/** Default pit-escape handler: reports no commits, renames successfully. */
function defaultEscapeHandler(req: Record<string, unknown>): object {
  if (req.op === "get-state") {
    return { branch: CURRENT_BRANCH, parentBranch: "main", mergeInProgress: false,
             conflicts: [], behindParent: false };
  }
  if (req.op === "git") {
    // Empty log → triggers conversation fallback
    return { stdout: "", stderr: "", code: 0 };
  }
  if (req.op === "rename-branch") {
    return { stdout: "", stderr: "", code: 0 };
  }
  return { error: `unknown op: ${req.op}` };
}

/** pit-escape handler that returns commits so git context is used. */
function withCommitsHandler(req: Record<string, unknown>): object {
  if (req.op === "get-state") {
    return { branch: CURRENT_BRANCH, parentBranch: "main", mergeInProgress: false,
             conflicts: [], behindParent: false };
  }
  if (req.op === "git") {
    const args = req.args as string[];
    if (args[0] === "log") return { stdout: "abc1234 add rename-branch command\n", stderr: "", code: 0 };
    if (args[0] === "diff") return { stdout: " rename-branch.ts | 50 +++++\n 1 file changed\n", stderr: "", code: 0 };
  }
  if (req.op === "rename-branch") {
    return { stdout: "", stderr: "", code: 0 };
  }
  return { error: `unknown op: ${req.op}` };
}

const servers: net.Server[] = [];
const socketPaths: string[] = [];
let fixture: ReturnType<typeof setupWorktreeFixture>;
const originalCwd = process.cwd();

beforeEach(() => {
  fs.mkdirSync(TEST_SANDBOX, { recursive: true });
  fixture = setupWorktreeFixture();
  process.chdir(fixture.worktreeDir);
  vi.mocked(complete).mockResolvedValue(aiResponse("fix-branch-renaming") as any);
});

afterEach(async () => {
  process.chdir(originalCwd);
  fixture.cleanup();
  delete process.env.PIT_ESCAPE_SOCKET;
  vi.clearAllMocks();
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  servers.length = 0;
  for (const p of socketPaths) { try { fs.unlinkSync(p); } catch { /* gone */ } }
  socketPaths.length = 0;
});

function makeSocketPath(): string {
  const p = path.join(
    TEST_SANDBOX,
    `rename-branch-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`
  );
  socketPaths.push(p);
  return p;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("/rename-branch command", () => {
  it("does NOT register when PIT_ESCAPE_SOCKET is unset", () => {
    delete process.env.PIT_ESCAPE_SOCKET;
    const pi = makeMockPi();
    renameBranchExt(pi as any);
    expect(pi.getCommand("rename-branch")).toBeUndefined();
  });

  it("registers when PIT_ESCAPE_SOCKET is set", () => {
    const socketPath = makeSocketPath();
    const { server } = startMockEscape(socketPath, defaultEscapeHandler);
    servers.push(server);
    process.env.PIT_ESCAPE_SOCKET = socketPath;

    const pi = makeMockPi();
    renameBranchExt(pi as any);
    expect(pi.getCommand("rename-branch")).toBeDefined();
  });

  it("uses git log + diff stat as context when branch has commits", async () => {
    const socketPath = makeSocketPath();
    const { received, server } = startMockEscape(socketPath, withCommitsHandler);
    servers.push(server);
    process.env.PIT_ESCAPE_SOCKET = socketPath;

    const pi = makeMockPi();
    renameBranchExt(pi as any);
    const ctx = makeMockCtx();
    await pi.getCommand("rename-branch")!.handler("", ctx);

    // get-state + log + diff + rename-branch = 4 requests
    expect(received).toHaveLength(4);
    expect(received[0]).toMatchObject({ op: "get-state" });
    // log and diff are parallel — just check both arrived
    const ops = (received as Array<Record<string, unknown>>).map((r) => r.op);
    expect(ops).toContain("git");
    expect(ops).toContain("rename-branch");
    expect(vi.mocked(complete)).toHaveBeenCalledOnce();
    // Prompt should contain the commit message, not conversation text
    const prompt = (vi.mocked(complete).mock.calls[0][1] as any).messages[0].content[0].text;
    expect(prompt).toContain("add rename-branch command");
    expect(prompt).not.toContain("User:");
  });

  it("falls back to conversation when log is empty (no commits)", async () => {
    const socketPath = makeSocketPath();
    const { server } = startMockEscape(socketPath, defaultEscapeHandler);
    servers.push(server);
    process.env.PIT_ESCAPE_SOCKET = socketPath;

    const pi = makeMockPi();
    renameBranchExt(pi as any);
    const ctx = makeMockCtx();
    await pi.getCommand("rename-branch")!.handler("", ctx);

    expect(vi.mocked(complete)).toHaveBeenCalledOnce();
    const prompt = (vi.mocked(complete).mock.calls[0][1] as any).messages[0].content[0].text;
    expect(prompt).toContain("Add branch renaming"); // from CONVERSATION_ENTRIES
  });

  it("renames branch and notifies success", async () => {
    const socketPath = makeSocketPath();
    const { server } = startMockEscape(socketPath, defaultEscapeHandler);
    servers.push(server);
    process.env.PIT_ESCAPE_SOCKET = socketPath;

    vi.mocked(complete).mockResolvedValue(aiResponse("add-rename-command") as any);

    const pi = makeMockPi();
    renameBranchExt(pi as any);
    const ctx = makeMockCtx();
    await pi.getCommand("rename-branch")!.handler("", ctx);

    const success = ctx.notifications.find((n) => n.level === "info" &&
      n.message.includes("pi/add-rename-command"));
    expect(success).toBeDefined();
  });

  it("preserves the branch prefix (pi/)", async () => {
    const socketPath = makeSocketPath();
    const received: object[] = [];
    const { server } = startMockEscape(socketPath, (req) => {
      received.push(req);
      return defaultEscapeHandler(req);
    });
    servers.push(server);
    process.env.PIT_ESCAPE_SOCKET = socketPath;

    vi.mocked(complete).mockResolvedValue(aiResponse("fix-auth") as any);

    const pi = makeMockPi();
    renameBranchExt(pi as any);
    await pi.getCommand("rename-branch")!.handler("", makeMockCtx());

    const renameReq = (received as Array<Record<string, unknown>>)
      .find((r) => r.op === "rename-branch");
    expect(renameReq).toMatchObject({ op: "rename-branch", newBranch: "pi/fix-auth" });
  });

  it("sanitises the slug (uppercase, spaces, special chars)", async () => {
    const socketPath = makeSocketPath();
    const received: object[] = [];
    const { server } = startMockEscape(socketPath, (req) => {
      received.push(req);
      return defaultEscapeHandler(req);
    });
    servers.push(server);
    process.env.PIT_ESCAPE_SOCKET = socketPath;

    vi.mocked(complete).mockResolvedValue(aiResponse("Fix Auth Flow!!") as any);

    const pi = makeMockPi();
    renameBranchExt(pi as any);
    await pi.getCommand("rename-branch")!.handler("", makeMockCtx());

    const renameReq = (received as Array<Record<string, unknown>>)
      .find((r) => r.op === "rename-branch");
    expect(renameReq).toMatchObject({ newBranch: "pi/fix-auth-flow" });
  });

  it("notifies info and skips rename when branch is already correctly named", async () => {
    const socketPath = makeSocketPath();
    const { received, server } = startMockEscape(socketPath, defaultEscapeHandler);
    servers.push(server);
    process.env.PIT_ESCAPE_SOCKET = socketPath;

    // Slug matches the current branch id
    vi.mocked(complete).mockResolvedValue(aiResponse("fd9b759f") as any);

    const pi = makeMockPi();
    renameBranchExt(pi as any);
    const ctx = makeMockCtx();
    await pi.getCommand("rename-branch")!.handler("", ctx);

    const renameReq = (received as Array<Record<string, unknown>>)
      .find((r) => r.op === "rename-branch");
    expect(renameReq).toBeUndefined();
    expect(ctx.notifications.find((n) => n.message.includes("already named"))).toBeDefined();
  });

  it("notifies error when model returns invalid JSON", async () => {
    const socketPath = makeSocketPath();
    const { server } = startMockEscape(socketPath, defaultEscapeHandler);
    servers.push(server);
    process.env.PIT_ESCAPE_SOCKET = socketPath;

    vi.mocked(complete).mockResolvedValue({
      content: [{ type: "text" as const, text: "not json at all" }],
    } as any);

    const pi = makeMockPi();
    renameBranchExt(pi as any);
    const ctx = makeMockCtx();
    await pi.getCommand("rename-branch")!.handler("", ctx);

    expect(ctx.notifications.find((n) => n.level === "error")).toBeDefined();
  });

  it("notifies error when model returns an empty slug", async () => {
    const socketPath = makeSocketPath();
    const { server } = startMockEscape(socketPath, defaultEscapeHandler);
    servers.push(server);
    process.env.PIT_ESCAPE_SOCKET = socketPath;

    vi.mocked(complete).mockResolvedValue(aiResponse("") as any);

    const pi = makeMockPi();
    renameBranchExt(pi as any);
    const ctx = makeMockCtx();
    await pi.getCommand("rename-branch")!.handler("", ctx);

    expect(ctx.notifications.find((n) => n.level === "error" &&
      n.message.includes("empty"))).toBeDefined();
  });

  it("notifies error when pit-escape returns a rename failure", async () => {
    const socketPath = makeSocketPath();
    const { server } = startMockEscape(socketPath, (req) => {
      if (req.op === "rename-branch") return { error: "branch already exists" };
      return defaultEscapeHandler(req);
    });
    servers.push(server);
    process.env.PIT_ESCAPE_SOCKET = socketPath;

    const pi = makeMockPi();
    renameBranchExt(pi as any);
    const ctx = makeMockCtx();
    await pi.getCommand("rename-branch")!.handler("", ctx);

    expect(ctx.notifications.find((n) => n.level === "error" &&
      n.message.includes("rename failed"))).toBeDefined();
  });

  it("notifies warning when no model is configured", async () => {
    const socketPath = makeSocketPath();
    const { server } = startMockEscape(socketPath, defaultEscapeHandler);
    servers.push(server);
    process.env.PIT_ESCAPE_SOCKET = socketPath;

    const pi = makeMockPi();
    renameBranchExt(pi as any);
    const ctx = makeMockCtx({ model: null });
    await pi.getCommand("rename-branch")!.handler("", ctx);

    expect(ctx.notifications.find((n) => n.level === "warning" &&
      n.message.includes("model"))).toBeDefined();
  });
});
