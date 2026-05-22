/**
 * Unit tests for the bundled git tool extension.
 *
 * The git tool is agent-facing: it registers a "git" tool that routes
 * permitted subcommands through pit-escape via Unix socket. The allowlist
 * is enforced by pit-escape; the tool passes args through unchanged.
 *
 * Strategy: mock the ExtensionAPI (registerTool) and run a local Unix socket
 * server as a stand-in for pit-escape. No real git, no bwrap, no spawning.
 *
 * What's under test:
 *   - Tool is registered when PIT_ESCAPE_SOCKET is set
 *   - Tool is NOT registered when PIT_ESCAPE_SOCKET is unset
 *   - execute() sends { op: "git", args } to the socket
 *   - Successful response is formatted correctly (text content, isError false)
 *   - Non-zero exit code sets isError true
 *   - Socket error response sets isError true
 */

import { fileURLToPath } from "node:url";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import gitToolExt from "../src/extensions/tools/git.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

const TEST_SANDBOX = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "test-sandbox"
);

type ToolParams = { args: string[] };
type ToolResult = { content: { type: string; text: string }[]; isError: boolean; details: { code: number | undefined } };
type RegisteredTool = { execute: (_id: string, params: ToolParams, signal: AbortSignal) => Promise<ToolResult> };

function makeMockPi() {
  let tool: RegisteredTool | undefined;
  return {
    registerTool(t: RegisteredTool) { tool = t; },
    getTool() { return tool; },
  };
}

function startMockEscape(socketPath: string, response: object) {
  const received: object[] = [];
  const server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk: Buffer) => { buf += chunk.toString("utf8"); });
    socket.once("end", () => {
      try { received.push(JSON.parse(buf.trim())); } catch { /* ignore */ }
    });
    socket.end(JSON.stringify(response) + "\n");
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
  const p = path.join(TEST_SANDBOX, `git-tool-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
  socketPaths.push(p);
  return p;
}

const tick = () => new Promise((r) => setTimeout(r, 50));

// ── tests ─────────────────────────────────────────────────────────────────────

describe("bundled git tool", () => {
  it("registers the git tool when PIT_ESCAPE_SOCKET is set", () => {
    const socketPath = makeSocketPath();
    const { server } = startMockEscape(socketPath, { stdout: "", stderr: "", code: 0 });
    servers.push(server);

    process.env.PIT_ESCAPE_SOCKET = socketPath;
    const pi = makeMockPi();
    gitToolExt(pi as any);

    expect(pi.getTool()).toBeDefined();
  });

  it("does NOT register the git tool when PIT_ESCAPE_SOCKET is unset", () => {
    delete process.env.PIT_ESCAPE_SOCKET;
    const pi = makeMockPi();
    gitToolExt(pi as any);

    expect(pi.getTool()).toBeUndefined();
  });

  it("sends { op: 'git', args } to pit-escape and returns text output", async () => {
    const socketPath = makeSocketPath();
    const { received, server } = startMockEscape(socketPath, { stdout: "main\n", stderr: "", code: 0 });
    servers.push(server);

    process.env.PIT_ESCAPE_SOCKET = socketPath;
    const pi = makeMockPi();
    gitToolExt(pi as any);

    const result = await pi.getTool()!.execute("1", { args: ["status"] }, new AbortController().signal);
    await tick();

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ op: "git", args: ["status"] });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toBe("main");
  });

  it("sets isError true when pit-escape returns a non-zero exit code", async () => {
    const socketPath = makeSocketPath();
    const { server } = startMockEscape(socketPath, { stdout: "", stderr: "fatal: not a git repo", code: 128 });
    servers.push(server);

    process.env.PIT_ESCAPE_SOCKET = socketPath;
    const pi = makeMockPi();
    gitToolExt(pi as any);

    const result = await pi.getTool()!.execute("1", { args: ["status"] }, new AbortController().signal);

    expect(result.isError).toBe(true);
    expect(result.details.code).toBe(128);
  });

  it("sets isError true when pit-escape returns an error object", async () => {
    const socketPath = makeSocketPath();
    const { server } = startMockEscape(socketPath, { error: "git status: not permitted" });
    servers.push(server);

    process.env.PIT_ESCAPE_SOCKET = socketPath;
    const pi = makeMockPi();
    gitToolExt(pi as any);

    const result = await pi.getTool()!.execute("1", { args: ["branch"] }, new AbortController().signal);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not permitted");
  });
});
