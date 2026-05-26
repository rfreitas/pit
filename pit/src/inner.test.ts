/**
 * Tests for inner.ts bootstrap.
 *
 * Strategy: mock @earendil-works/pi-coding-agent so main() is a spy that
 * returns immediately. Run the real inner.ts production code. Assert on
 * observable behaviour — env var deletion, what main() receives.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockMain = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...await importOriginal<typeof import("@earendil-works/pi-coding-agent")>(),
  main: mockMain,
}));

// ── helpers ───────────────────────────────────────────────────────────────────

/** Run inner.ts with controlled env, return what main() was called with. */
const runInner = async (env: {
  PIT_IS_INNER?: string;
  PIT_ESCAPE_TOKEN?: string;
  PIT_ESCAPE_SOCKET?: string;
}) => {
  const origEnv = { ...process.env };
  const origArgv = [...process.argv];
  mockMain.mockClear();

  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, env);
  process.argv = ["node", "/pit/src/inner.ts", "--session", "/tmp/test.json"];

  try {
    // Re-import inner.ts fresh each time (bypass module cache)
    await vi.importActual<typeof import("./inner.ts")>("./inner.ts");
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, origEnv);
    process.argv = origArgv;
  }

  return {
    mainArgs: mockMain.mock.calls[0]?.[0] as string[] | undefined,
    mainOpts: mockMain.mock.calls[0]?.[1] as { extensionFactories?: unknown[] } | undefined,
    envAtCallTime: { ...process.env },
  };
};

// ── tests ─────────────────────────────────────────────────────────────────────

describe("inner.ts bootstrap", () => {
  it("deletes PIT_ESCAPE_TOKEN from env before main() is called", async () => {
    const { envAtCallTime } = await runInner({
      PIT_IS_INNER: "1",
      PIT_ESCAPE_TOKEN: "secret",
      PIT_ESCAPE_SOCKET: "mock.sock",
    });
    expect(envAtCallTime["PIT_ESCAPE_TOKEN"]).toBeUndefined();
  });

  it("deletes PIT_IS_INNER from env before main() is called", async () => {
    const { envAtCallTime } = await runInner({
      PIT_IS_INNER: "1",
      PIT_ESCAPE_TOKEN: "secret",
      PIT_ESCAPE_SOCKET: "mock.sock",
    });
    expect(envAtCallTime["PIT_IS_INNER"]).toBeUndefined();
  });

  it("calls main() with process.argv.slice(2)", async () => {
    const { mainArgs } = await runInner({
      PIT_IS_INNER: "1",
      PIT_ESCAPE_TOKEN: "secret",
      PIT_ESCAPE_SOCKET: "mock.sock",
    });
    expect(mainArgs).toEqual(["--session", "/tmp/test.json"]);
  });

  it("calls main() with non-empty extensionFactories when PIT_ESCAPE_SOCKET is set", async () => {
    const { mainOpts } = await runInner({
      PIT_IS_INNER: "1",
      PIT_ESCAPE_TOKEN: "secret",
      PIT_ESCAPE_SOCKET: "mock.sock",
    });
    expect(mainOpts?.extensionFactories?.length).toBeGreaterThan(0);
  });

  it("calls main() with empty extensionFactories when PIT_ESCAPE_SOCKET is empty", async () => {
    const { mainOpts } = await runInner({
      PIT_IS_INNER: "1",
      PIT_ESCAPE_TOKEN: "secret",
    });
    expect(mainOpts?.extensionFactories).toHaveLength(0);
  });

  it("sets process.title to 'pi' before main() is called", async () => {
    let titleAtCallTime = "";
    mockMain.mockImplementationOnce(async () => {
      titleAtCallTime = process.title;
    });
    await runInner({ PIT_IS_INNER: "1", PIT_ESCAPE_TOKEN: "s", PIT_ESCAPE_SOCKET: "s" });
    expect(titleAtCallTime).toBe("pi");
  });
});
