/**
 * Tests for createExtensionFactories.
 *
 * Strategy: invoke all factories on a mock ExtensionAPI and assert that the
 * correct tool/command names are registered and that sendEffect is called with
 * the token. Does NOT test factory count — that is an implementation detail.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const mockSendEffect = vi.hoisted(() =>
  vi.fn()
);


vi.mock("./escape/client.ts", () => ({
  sendEffect: mockSendEffect,
  isOk: (r: { code: number }) => r.code === 0,
  errMsg: () => "error",
}));

import { Effect } from "effect";
import { createExtensionFactories } from "./index.ts";

// ── mock ExtensionAPI ─────────────────────────────────────────────────────────

const makeMockPi = (): ExtensionAPI => ({
  registerTool: vi.fn(),
  registerCommand: vi.fn(),
  on: vi.fn(),
  ui: { setStatus: vi.fn() },
} as unknown as ExtensionAPI);

/** Build a richer mock that captures session_start setStatus calls. */
const makeMockPiWithStatusCapture = () => {
  const statuses: Record<string, string | undefined> = {};
  const sessionStartHandlers: Array<(event: unknown, ctx: { cwd: string; ui: { setStatus: (k: string, v: string | undefined) => void } }) => Promise<void>> = [];

  const pi = {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => {
      if (event === "session_start") sessionStartHandlers.push(handler);
    }),
    ui: { setStatus: vi.fn((k: string, v: string | undefined) => { statuses[k] = v; }) },
  } as unknown as ExtensionAPI;

  const triggerSessionStart = async (cwd: string) => {
    const setStatus = (k: string, v: string | undefined) => { statuses[k] = v; };
    for (const handler of sessionStartHandlers) {
      await handler("session_start", { cwd, ui: { setStatus } });
    }
  };

  return { pi, statuses, triggerSessionStart };
};

describe("createExtensionFactories", () => {
  beforeEach(() => {
    mockSendEffect.mockClear();
    // Must return a proper Effect so Effect.gen can yield* it.
    // Branch status reads nested fields — return a valid shape so it doesn't crash.
    mockSendEffect.mockImplementation((_socket, _token, payload: { op?: string }) => {
      if (payload?.op === "branch-status") {
        return Effect.succeed({
          code: 0, stdout: "", stderr: "",
          aheadCount: 0, behindCount: 0, parentBranch: "main",
          detachedHead: false, mergeInProgress: false,
          aheadNumstat: "", stagedNumstat: "", unstagedNumstat: "",
        });
      }
      return Effect.succeed({ stdout: "", stderr: "", code: 0 });
    });
  });

  it("returns mode footer only when socketPath is empty", () => {
    expect(createExtensionFactories("", "any-token", false)).toHaveLength(1);
  });

  it("registers git tool", async () => {
    const pi = makeMockPi();
    for (const factory of createExtensionFactories("mock.sock", "tok", false)) await factory(pi);
    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "git" }),
    );
  });

  it("registers merge command", async () => {
    const pi = makeMockPi();
    for (const factory of createExtensionFactories("mock.sock", "tok", false)) await factory(pi);
    expect(pi.registerCommand).toHaveBeenCalledWith("merge", expect.anything());
  });

  it("registers rename-branch command", async () => {
    const pi = makeMockPi();
    for (const factory of createExtensionFactories("mock.sock", "tok", false)) await factory(pi);
    expect(pi.registerCommand).toHaveBeenCalledWith("rename-branch", expect.anything());
  });

  it("registers session_shutdown hook (reload)", async () => {
    const pi = makeMockPi();
    for (const factory of createExtensionFactories("mock.sock", "tok", false)) await factory(pi);
    expect(pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
  });

  it("mode status shows 'no sandbox' when socket is alive but sandbox is not active", async () => {
    // This is the bug: even when the escape socket is alive (for git tools etc),
    // if bwrap/sandbox-exec didn't actually launch, the status should say "no sandbox".
    // The current code uses socketPath as a proxy for sandbox, so this test FAILS
    // until createModeStatus receives sandbox as a separate boolean.
    const { pi, statuses, triggerSessionStart } = makeMockPiWithStatusCapture();
    // sandbox: false, but socket is alive (e.g. escape server started for git tools)
    const factories = createExtensionFactories("mock.sock", "token", false);
    for (const factory of factories) await factory(pi);
    await triggerSessionStart("/tmp/test-cwd");
    expect(statuses["pit-sandbox"]).toBe("no sandbox");
  });

  it("includes token in sendEffect call when git tool executes", async () => {
    const pi = makeMockPi();
    for (const factory of createExtensionFactories("mock.sock", "secret-token", false)) await factory(pi);

    // Find the registered git tool and invoke its execute
    const [toolDef] = (pi.registerTool as ReturnType<typeof vi.fn>).mock.calls
      .find((call: unknown[]) => (call[0] as Record<string, unknown>)["name"] === "git") ?? [];
    expect(toolDef).toBeDefined();

    await toolDef.execute("id", { args: ["status"] }, undefined, undefined, undefined);
    expect(mockSendEffect).toHaveBeenCalledWith(
      "mock.sock",
      "secret-token",
      expect.objectContaining({ op: "git" }),
    );
  });
});
