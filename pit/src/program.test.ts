/**
 * TDD tests for nonSandboxExtensions config and settings filtering removal.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── fixtures ──────────────────────────────────────────────────────────────────

const mockMain = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("@earendil-works/pi-coding-agent", async (orig) => ({
  ...await orig<typeof import("@earendil-works/pi-coding-agent")>(),
  main: mockMain,
}));

// ── mocks for sandbox tool detection and launches ──────────────────────────────

const { mockFindSandboxTool } = vi.hoisted(() => ({
  mockFindSandboxTool: vi.fn(() => null as { kind: "bwrap"; path: string } | { kind: "sandbox-exec" } | null),
}));

vi.mock("./launcher.ts", async (orig) => {
  const real = await orig<typeof import("./launcher.ts")>();
  return {
    ...real,
    findSandboxTool: mockFindSandboxTool,
    sbplLaunch: vi.fn().mockResolvedValue(undefined),
  };
});

import { Effect } from "effect";
import { layer as NodeContextLayer } from "./node-context.ts";
import { run } from "./tests/helpers.ts";
import { launchEffect } from "./launcher.ts";
import { nonSandboxExtensionFlags } from "./core/sandbox/pure.ts";

// ── tests ─────────────────────────────────────────────────────────────────────

describe("nonSandboxExtensionFlags", () => {
  it("returns flat --extension flags for configured paths", () => {
    expect(nonSandboxExtensionFlags(
      { nonSandboxExtensions: ["/ext/a", "/ext/b"] },
    )).toEqual(["--extension", "/ext/a", "--extension", "/ext/b"]);
  });

  it("returns empty array for undefined nonSandboxExtensions", () => {
    expect(nonSandboxExtensionFlags({})).toEqual([]);
  });

  it("returns empty array when pitConfig is undefined", () => {
    expect(nonSandboxExtensionFlags(undefined)).toEqual([]);
  });
});

describe("launchEffect mode-based extension passing", () => {
  beforeEach(() => {
    mockMain.mockClear();
    mockFindSandboxTool.mockReturnValue(null);
    vi.spyOn(process, "chdir").mockImplementation(() => undefined);
  });

  const launch = (sandbox: boolean, pitConfig?: Parameters<typeof launchEffect>[6]) =>
    run(
      launchEffect(
        "/tmp/test-cwd",           // cwd
        ["--some-pi-flag"],        // piArgs
        sandbox,                   // sandbox
        undefined,                 // settingsPath
        undefined,                 // mounts
        pitConfig,                 // pitConfig
      ),
    );

  it("passes nonSandboxExtensions as --extension flags in non-sandbox mode", async () => {
    await launch(false, { nonSandboxExtensions: ["/ext/a"] });
    expect(mockMain).toHaveBeenCalledTimes(1);
    const args = mockMain.mock.calls[0]![0] as string[];
    expect(args).toContain("--extension");
    expect(args).toContain("/ext/a");
  });

  it("does not add nonSandboxExtension flags when pitConfig has none", async () => {
    await launch(false, {});
    const args = mockMain.mock.calls[0]![0] as string[];
    expect(args.filter(a => a === "--extension")).toHaveLength(0);
  });
});
