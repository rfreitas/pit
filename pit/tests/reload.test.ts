/**
 * Unit tests for the pit bundled reload extension.
 *
 * The reload extension hooks session_shutdown with reason "reload" and calls
 * pit-escape's refresh-settings op before pi tears down and re-reads packages.
 * This ensures /reload picks up globally-installed packages with the denylist
 * still applied.
 *
 * Strategy: mock the ExtensionAPI (just `on()`) and a local Unix socket server
 * that plays the role of pit-escape. No pi process, no bwrap, no spawning.
 *
 * The module is imported once. PIT_ESCAPE_SOCKET is read inside the default
 * export function body, so setting the env var before each call is enough —
 * no cache-busting or re-importing needed.
 *
 * What's under test:
 *   - Extension registers a session_shutdown handler when PIT_ESCAPE_SOCKET is set
 *   - Handler sends { op: "refresh-settings" } to the socket on reason "reload"
 *   - Handler does NOT fire for other shutdown reasons (quit, fork, new, resume)
 *   - Extension is inert (no handler) when PIT_ESCAPE_SOCKET is unset
 *   - Handler completes even if the socket returns an error (non-fatal)
 *   - Handler completes even if the socket is unreachable (non-fatal)
 */

import { fileURLToPath } from "node:url";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import reloadExt from "../src/extensions/hooks/reload.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

const TEST_SANDBOX = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "test-sandbox"
);

type ShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";

/** Minimal mock of the ExtensionAPI — only the surface reload.ts uses. */
function makeMockPi() {
  const handlers = new Map<string, (event: Record<string, unknown>) => Promise<void>>();
  return {
    on(event: string, handler: (event: Record<string, unknown>) => Promise<void>) {
      handlers.set(event, handler);
    },
    trigger(event: string, payload: Record<string, unknown>) {
      return handlers.get(event)?.(payload) ?? Promise.resolve();
    },
    hasHandler(event: string) {
      return handlers.has(event);
    },
  };
}

/** Start a mock Unix socket server that plays the role of pit-escape. */
function startMockEscape(socketPath: string, response: object = { ok: true }) {
  const received: object[] = [];
  const server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk: Buffer) => { buf += chunk.toString("utf8"); });
    // Respond immediately then let client close
    socket.end(JSON.stringify(response) + "\n");
    socket.once("end", () => {
      try { received.push(JSON.parse(buf.trim())); } catch { /* ignore */ }
    });
  });
  server.listen(socketPath);
  return { received, server };
}

const servers: net.Server[] = [];
const socketPaths: string[] = [];

beforeEach(() => {
  fs.mkdirSync(TEST_SANDBOX, { recursive: true });
});

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
    `mock-escape-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`
  );
  socketPaths.push(p);
  return p;
}

// Brief pause so socket data has time to arrive at the server after the
// client closes — sockets are async and the test assertions run sync.
const tick = () => new Promise((r) => setTimeout(r, 50));

// ── tests ─────────────────────────────────────────────────────────────────────

describe("bundled reload extension", () => {
  it("registers a session_shutdown handler when PIT_ESCAPE_SOCKET is set", () => {
    const socketPath = makeSocketPath();
    const { server } = startMockEscape(socketPath);
    servers.push(server);

    process.env.PIT_ESCAPE_SOCKET = socketPath;
    const pi = makeMockPi();
    reloadExt(pi as any);

    expect(pi.hasHandler("session_shutdown")).toBe(true);
  });

  it("does NOT register any handler when PIT_ESCAPE_SOCKET is unset", () => {
    delete process.env.PIT_ESCAPE_SOCKET;
    const pi = makeMockPi();
    reloadExt(pi as any);

    expect(pi.hasHandler("session_shutdown")).toBe(false);
  });

  it("sends { op: 'refresh-settings' } to the socket on reason 'reload'", async () => {
    const socketPath = makeSocketPath();
    const { received, server } = startMockEscape(socketPath);
    servers.push(server);

    process.env.PIT_ESCAPE_SOCKET = socketPath;
    const pi = makeMockPi();
    reloadExt(pi as any);

    await pi.trigger("session_shutdown", { type: "session_shutdown", reason: "reload" });
    await tick();

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ op: "refresh-settings" });
  });

  it("does NOT send to the socket on reason 'quit'", async () => {
    const socketPath = makeSocketPath();
    const { received, server } = startMockEscape(socketPath);
    servers.push(server);

    process.env.PIT_ESCAPE_SOCKET = socketPath;
    const pi = makeMockPi();
    reloadExt(pi as any);

    await pi.trigger("session_shutdown", { type: "session_shutdown", reason: "quit" });
    await tick();

    expect(received).toHaveLength(0);
  });

  it.each(["fork", "new", "resume"] as ShutdownReason[])(
    "does NOT send to the socket on reason '%s'",
    async (reason) => {
      const socketPath = makeSocketPath();
      const { received, server } = startMockEscape(socketPath);
      servers.push(server);

      process.env.PIT_ESCAPE_SOCKET = socketPath;
      const pi = makeMockPi();
      reloadExt(pi as any);

      await pi.trigger("session_shutdown", { type: "session_shutdown", reason });
      await tick();

      expect(received).toHaveLength(0);
    }
  );

  it("completes without throwing when the socket returns an error response", async () => {
    const socketPath = makeSocketPath();
    const { server } = startMockEscape(socketPath, { error: "something went wrong" });
    servers.push(server);

    process.env.PIT_ESCAPE_SOCKET = socketPath;
    const pi = makeMockPi();
    reloadExt(pi as any);

    await expect(
      pi.trigger("session_shutdown", { type: "session_shutdown", reason: "reload" })
    ).resolves.not.toThrow();
  });

  it("completes without throwing when the socket is unreachable", async () => {
    process.env.PIT_ESCAPE_SOCKET = path.join(TEST_SANDBOX, "no-such-socket.sock");
    const pi = makeMockPi();
    reloadExt(pi as any);

    await expect(
      pi.trigger("session_shutdown", { type: "session_shutdown", reason: "reload" })
    ).resolves.not.toThrow();
  });
});
