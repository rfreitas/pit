/**
 * Tests for createExtensionFactories.
 *
 * Strategy: invoke all factories on a mock ExtensionAPI and assert that the
 * correct tool/command names are registered and that sendEffect is called with
 * the token. Does NOT test factory count — that is an implementation detail.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const mockSendEffect = vi.hoisted(() => vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0 }));

vi.mock("../escape/client.ts", () => ({
  sendEffect: mockSendEffect,
  isOk: (r: { code: number }) => r.code === 0,
  errMsg: () => "error",
}));

import { createExtensionFactories } from "./index.ts";

// ── mock ExtensionAPI ─────────────────────────────────────────────────────────

const makeMockPi = (): ExtensionAPI => ({
  registerTool: vi.fn(),
  registerCommand: vi.fn(),
  on: vi.fn(),
  // fill in the rest as no-ops so TypeScript is satisfied
} as unknown as ExtensionAPI);

describe("createExtensionFactories", () => {
  beforeEach(() => { mockSendEffect.mockClear(); });

  it("returns empty array when socketPath is empty", () => {
    expect(createExtensionFactories("", "any-token")).toHaveLength(0);
  });

  it("registers git tool", async () => {
    const pi = makeMockPi();
    for (const factory of createExtensionFactories("mock.sock", "tok")) await factory(pi);
    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "git" }),
    );
  });

  it("registers merge command", async () => {
    const pi = makeMockPi();
    for (const factory of createExtensionFactories("mock.sock", "tok")) await factory(pi);
    expect(pi.registerCommand).toHaveBeenCalledWith("merge", expect.anything());
  });

  it("registers rename-branch command", async () => {
    const pi = makeMockPi();
    for (const factory of createExtensionFactories("mock.sock", "tok")) await factory(pi);
    expect(pi.registerCommand).toHaveBeenCalledWith("rename-branch", expect.anything());
  });

  it("registers session_shutdown hook (reload)", async () => {
    const pi = makeMockPi();
    for (const factory of createExtensionFactories("mock.sock", "tok")) await factory(pi);
    expect(pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
  });

  it("includes token in sendEffect call when git tool executes", async () => {
    const pi = makeMockPi();
    for (const factory of createExtensionFactories("mock.sock", "secret-token")) await factory(pi);

    // Find the registered git tool and invoke its execute
    const [toolDef] = (pi.registerTool as ReturnType<typeof vi.fn>).mock.calls
      .find(([def]: [{ name: string }][]) => def.name === "git") ?? [];
    expect(toolDef).toBeDefined();

    await toolDef.execute("id", { args: ["status"] }, { aborted: false });
    expect(mockSendEffect).toHaveBeenCalledWith(
      "mock.sock",
      "secret-token",
      expect.objectContaining({ op: "git" }),
    );
  });
});
