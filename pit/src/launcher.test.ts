/**
 * Tests for bwrapLaunch arg construction.
 *
 * Strategy: mock spawnSync via vi.mock so bwrapLaunch runs its full production
 * arg-building code without spawning a real bwrap process. Assert on the exact
 * args the mock receives.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSpawnSync, mockExecSync } = vi.hoisted(() => ({
  mockSpawnSync: vi.fn().mockReturnValue({ status: 0 }),
  mockExecSync: vi.fn().mockReturnValue("/usr/bin/pi\n"),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawnSync: mockSpawnSync,
  execSync: mockExecSync,
}));

// Stub realpathSync so tests don't hit the real filesystem for /usr/bin/pi
vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  realpathSync: (p: string) => p,
}));

import type { SandboxMounts, PitConfig } from "./types.ts";
import { bwrapLaunch } from "./launcher.ts";

// ── fixtures ──────────────────────────────────────────────────────────────────

const dummyMounts: SandboxMounts = {
  ro: [{ path: "/etc", label: "system dirs" }],
  rw: [{ path: "/work" }],
};

const baseConfig: PitConfig = { allowEnv: [] };

// ── helpers ───────────────────────────────────────────────────────────────────

/** Extract all --setenv key→value pairs from a bwrap arg list. */
const setenvPairs = (args: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length - 2; i++) {
    if (args[i] === "--setenv") out[args[i + 1]!] = args[i + 2]!;
  }
  return out;
};

/** Call bwrapLaunch with controlled process.argv[1] and process.env. */
const launch = (opts: {
  scriptPath?: string;
  env?: NodeJS.ProcessEnv;
  escapeToken?: string;
  pitConfig?: PitConfig;
}) => {
  const origArgv1 = process.argv[1];
  const origEnv = { ...process.env };

  process.argv[1] = opts.scriptPath ?? "/home/user/repos/agent/pit/pit.ts";
  // Replace env entirely so tests are deterministic
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, opts.env ?? { HOME: "/home/user", PATH: "/bin" });

  try {
    // process.exit is called at the end of bwrapLaunch — stub it
    const exitStub = vi.spyOn(process, "exit").mockImplementation(
      () => undefined as never,
    );
    bwrapLaunch("/work", [], dummyMounts, opts.pitConfig ?? baseConfig, undefined, opts.escapeToken);
    exitStub.mockRestore();
  } finally {
    process.argv[1] = origArgv1;
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, origEnv);
  }

  return mockSpawnSync.mock.calls[0]![1] as string[];
};

// ── tests ─────────────────────────────────────────────────────────────────────

describe("bwrapLaunch arg construction", () => {
  beforeEach(() => { mockSpawnSync.mockClear(); });

  it("includes --clearenv", () => {
    expect(launch({})).toContain("--clearenv");
  });

  it("includes HOME, PATH, PI_CODING_AGENT, PIT_IS_INNER in setenv list", () => {
    const pairs = setenvPairs(launch({ env: { HOME: "/home/u", PATH: "/bin" } }));
    expect(pairs["HOME"]).toBe("/home/u");
    expect(pairs["PI_CODING_AGENT"]).toBe("true");
    expect(pairs["PIT_IS_INNER"]).toBe("1");
    expect(pairs["PATH"]).toMatch(/\/bin/);
  });

  it("includes PIT_ESCAPE_TOKEN when escapeToken is provided", () => {
    const pairs = setenvPairs(launch({ escapeToken: "tok-secret" }));
    expect(pairs["PIT_ESCAPE_TOKEN"]).toBe("tok-secret");
  });

  it("does NOT include PIT_ESCAPE_TOKEN when no escapeToken", () => {
    expect(launch({})).not.toContain("PIT_ESCAPE_TOKEN");
  });

  it("includes PIT_ESCAPE_SOCKET when set in env", () => {
    const pairs = setenvPairs(launch({ env: { HOME: "/h", PIT_ESCAPE_SOCKET: "/tmp/pit.sock" } }));
    expect(pairs["PIT_ESCAPE_SOCKET"]).toBe("/tmp/pit.sock");
  });

  it("forwards allowEnv vars present in env", () => {
    const pairs = setenvPairs(launch({
      pitConfig: { allowEnv: ["MY_KEY"] },
      env: { HOME: "/h", MY_KEY: "my-val" },
    }));
    expect(pairs["MY_KEY"]).toBe("my-val");
  });

  it("does NOT forward allowEnv vars absent from env", () => {
    expect(launch({ pitConfig: { allowEnv: ["MISSING"] }, env: { HOME: "/h" } }))
      .not.toContain("MISSING");
  });

  it("adds --ro-bind for pitDir when script is in a local dev path", () => {
    const args = launch({ scriptPath: "/home/user/repos/agent/pit/pit.ts" });
    const idx = args.indexOf("/home/user/repos/agent/pit");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx - 1]).toBe("--ro-bind");
  });

  it("does NOT add pit --ro-bind when script is inside global lib/node_modules", () => {
    const args = launch({ scriptPath: "/usr/local/lib/node_modules/@ricfr/pit/pit.ts" });
    expect(args).not.toContain("/usr/local/lib/node_modules/@ricfr/pit");
  });

  it("execs inner.ts not the pi binary", () => {
    const args = launch({});
    const sep = args.indexOf("--");
    const execTarget = args[sep + 2];
    expect(execTarget).toMatch(/inner\.ts$/);
  });

  it("includes --experimental-strip-types before inner.ts", () => {
    const args = launch({});
    const sep = args.indexOf("--");
    const tail = args.slice(sep + 1);
    expect(tail).toContain("--experimental-strip-types");
    const stripIdx = tail.indexOf("--experimental-strip-types");
    const innerIdx = tail.findIndex(a => a.endsWith("inner.ts"));
    expect(stripIdx).toBeLessThan(innerIdx);
  });
});
