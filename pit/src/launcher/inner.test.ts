/**
 * Tests for inner.ts bootstrap.
 *
 * Strategy: mock @earendil-works/pi-coding-agent so main() is a spy.
 * Import and call the exported runInner() from inner.ts directly.
 * Assert on observable behaviour — env var deletion, what main() receives.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockMain = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...await importOriginal<typeof import("@earendil-works/pi-coding-agent")>(),
  main: mockMain,
}));

import { runInner } from "./inner.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

const run = async (env: {
  PIT_ESCAPE_TOKEN?: string;
  PIT_ESCAPE_SOCKET?: string;
}) => {
  const origEnv = { ...process.env };
  mockMain.mockClear();

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
  };
};

// ── tests ─────────────────────────────────────────────────────────────────────

describe("inner.ts bootstrap", () => {
  it("deletes PIT_ESCAPE_TOKEN from env before main() is called", async () => {
    let envSnapshot: string | undefined = "not-deleted";
    mockMain.mockImplementationOnce(async () => {
      envSnapshot = process.env.PIT_ESCAPE_TOKEN;
    });
    const env = { PIT_ESCAPE_TOKEN: "secret", PIT_ESCAPE_SOCKET: "s" };
    await run(env);
    expect(envSnapshot).toBeUndefined();
  });

  it("calls main() with the provided argv", async () => {
    const { mainArgs } = await run({ PIT_ESCAPE_TOKEN: "s", PIT_ESCAPE_SOCKET: "s" });
    expect(mainArgs).toEqual(["--session", "/tmp/test.json"]);
  });

  it("calls main() with non-empty extensionFactories when PIT_ESCAPE_SOCKET is set", async () => {
    const { mainOpts } = await run({ PIT_ESCAPE_TOKEN: "s", PIT_ESCAPE_SOCKET: "mock.sock" });
    expect(mainOpts?.extensionFactories?.length).toBeGreaterThan(0);
  });

  it("calls main() with mode footer only when PIT_ESCAPE_SOCKET is empty", async () => {
    const { mainOpts } = await run({ PIT_ESCAPE_TOKEN: "s" });
    // Mode footer is always registered; escape-based factories require socket.
    expect(mainOpts?.extensionFactories).toHaveLength(1);
  });

  it("sets process.title to 'pi' before main() is called", async () => {
    let titleSnapshot = "";
    mockMain.mockImplementationOnce(async () => { titleSnapshot = process.title; });
    await run({ PIT_ESCAPE_TOKEN: "s", PIT_ESCAPE_SOCKET: "s" });
    expect(titleSnapshot).toBe("pi");
  });
});
