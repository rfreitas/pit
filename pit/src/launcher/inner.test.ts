/**
 * Tests for inner.ts bootstrap.
 *
 * Strategy: mock @earendil-works/pi-coding-agent so main() is a spy.
 * Mock createExtensionFactories to spy on the sandboxed parameter.
 * Import and call the exported runInner() from inner.ts directly.
 * Assert on observable behaviour — env var deletion, what main() receives.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockMain = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockCreateExtensionFactories = vi.hoisted(() => vi.fn().mockReturnValue([]));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...await importOriginal<typeof import("@earendil-works/pi-coding-agent")>(),
  main: mockMain,
}));

vi.mock("../extensions/index.ts", () => ({
  createExtensionFactories: mockCreateExtensionFactories,
}));

import { runInner } from "./inner.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

const run = async (env: {
  PIT_SANDBOXED?: string;
  PIT_ESCAPE_TOKEN?: string;
  PIT_ESCAPE_SOCKET?: string;
}) => {
  const origEnv = { ...process.env };
  mockMain.mockClear();
  mockCreateExtensionFactories.mockClear();

  // Inject test env vars
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, env);

  try {
    await runInner(["--session", "/tmp/test.json"], process.env);
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, origEnv);
  }

  return {
    mainArgs: mockMain.mock.calls[0]?.[0] as string[] | undefined,
    mainOpts: mockMain.mock.calls[0]?.[1] as { extensionFactories?: unknown[] } | undefined,
    factoriesCallArgs: mockCreateExtensionFactories.mock.calls[0] as [string, string, boolean] | undefined,
  };
};

// ── tests ─────────────────────────────────────────────────────────────────────

describe("inner.ts bootstrap", () => {
  it("deletes PIT_ESCAPE_TOKEN from env before main() is called", async () => {
    let envSnapshot: string | undefined = "not-deleted";
    mockMain.mockImplementationOnce(async () => {
      envSnapshot = process.env.PIT_ESCAPE_TOKEN;
    });
    const env = { PIT_SANDBOXED: "1", PIT_ESCAPE_TOKEN: "secret", PIT_ESCAPE_SOCKET: "s" };
    await run(env);
    expect(envSnapshot).toBeUndefined();
  });

  it("deletes PIT_SANDBOXED from env before main() is called", async () => {
    let envSnapshot: string | undefined = "not-deleted";
    mockMain.mockImplementationOnce(async () => {
      envSnapshot = process.env.PIT_SANDBOXED;
    });
    const env = { PIT_SANDBOXED: "1", PIT_ESCAPE_TOKEN: "secret", PIT_ESCAPE_SOCKET: "s" };
    await run(env);
    expect(envSnapshot).toBeUndefined();
  });

  it("passes sandboxed=true when PIT_SANDBOXED=1", async () => {
    const { factoriesCallArgs } = await run({ PIT_SANDBOXED: "1", PIT_ESCAPE_SOCKET: "s" });
    expect(factoriesCallArgs?.[2]).toBe(true);
  });

  it("passes sandboxed=false when PIT_SANDBOXED is absent", async () => {
    const { factoriesCallArgs } = await run({ PIT_ESCAPE_SOCKET: "s" });
    expect(factoriesCallArgs?.[2]).toBe(false);
  });

  it("calls main() with the provided argv", async () => {
    const { mainArgs } = await run({ PIT_SANDBOXED: "1", PIT_ESCAPE_TOKEN: "s", PIT_ESCAPE_SOCKET: "s" });
    expect(mainArgs).toEqual(["--session", "/tmp/test.json"]);
  });

  it("passes socketPath and token to createExtensionFactories", async () => {
    const { factoriesCallArgs } = await run({ PIT_SANDBOXED: "1", PIT_ESCAPE_TOKEN: "tok", PIT_ESCAPE_SOCKET: "sock" });
    expect(factoriesCallArgs?.[0]).toBe("sock");
    expect(factoriesCallArgs?.[1]).toBe("tok");
  });

  it("passes empty token when PIT_ESCAPE_TOKEN is absent", async () => {
    const { factoriesCallArgs } = await run({ PIT_SANDBOXED: "1", PIT_ESCAPE_SOCKET: "s" });
    expect(factoriesCallArgs?.[1]).toBe("");
  });

  it("sets process.title to 'pi' before main() is called", async () => {
    let titleSnapshot = "";
    mockMain.mockImplementationOnce(async () => { titleSnapshot = process.title; });
    await run({ PIT_SANDBOXED: "1", PIT_ESCAPE_TOKEN: "s", PIT_ESCAPE_SOCKET: "s" });
    expect(titleSnapshot).toBe("pi");
  });
});
