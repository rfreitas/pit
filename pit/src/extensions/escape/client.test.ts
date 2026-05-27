/**
 * Tests for probeSocket — the escape client helper that detects whether a
 * pit-escape process is already listening on a given socket path.
 *
 * Three states under test:
 *   "alive"  — socket file exists and a process accepted the connection
 *   "stale"  — socket file exists but nobody is listening
 *   "absent" — socket file does not exist
 *
 * Strategy: use real Unix sockets and a real pit-escape process (via the
 * existing spawnEscape helper) rather than mocks, keeping the tests honest
 * about actual OS behaviour.
 */
import { fileURLToPath } from "node:url";
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { probeSocket } from "./client.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

const TEST_SANDBOX = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "test-sandbox");
const PIT_ESCAPE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "escape", "server.ts");

const tmpDirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const c of children) { try { c.kill("SIGTERM"); } catch { /* gone */ } }
  children.length = 0;
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

function makeDir(): string {
  fs.mkdirSync(TEST_SANDBOX, { recursive: true });
  const d = fs.mkdtempSync(path.join(TEST_SANDBOX, "probe-test-"));
  tmpDirs.push(d);
  return d;
}

/** Spawn pit-escape and wait for it to signal readiness. */
async function spawnEscape(socketPath: string): Promise<void> {
  const dir = makeDir();
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--no-warnings",
      PIT_ESCAPE,
      "probe-test-token",  // token (arbitrary — probe tests don't send ops)
      socketPath,
      dir,          // worktreePath (dummy)
      dir,          // agentDir (dummy)
      dir,          // pitDir (dummy)
      path.join(dir, "settings.json"),  // hostSettingsPath (dummy)
    ],
    { stdio: ["ignore", "pipe", "inherit"] }
  );
  children.push(child);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("pit-escape timed out")), 5000);
    child.stdout!.once("data", () => { clearTimeout(timer); resolve(); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) reject(new Error(`pit-escape exited ${code}`));
    });
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("probeSocket", () => {
  it("returns 'absent' when the socket file does not exist", async () => {
    const socketPath = path.join(makeDir(), "nonexistent.sock");
    expect(await probeSocket(socketPath)).toBe("absent");
  });

  it("returns 'alive' when pit-escape is listening", async () => {
    const socketPath = path.join(makeDir(), "live.sock");
    await spawnEscape(socketPath);
    expect(await probeSocket(socketPath)).toBe("alive");
  });

  it("returns 'stale' when socket path exists but nothing is listening", async () => {
    const socketPath = path.join(makeDir(), "stale.sock");
    // A regular file at the socket path is not a listening socket.
    // connect() fails with ECONNREFUSED (not ENOENT), which maps to "stale".
    fs.writeFileSync(socketPath, "");
    expect(await probeSocket(socketPath)).toBe("stale");
  });

  it("returns 'absent' (not 'alive') after the process exits cleanly", async () => {
    const socketPath = path.join(makeDir(), "dies.sock");
    await spawnEscape(socketPath);
    expect(await probeSocket(socketPath)).toBe("alive");

    children[children.length - 1].kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 150));

    // SIGTERM triggers cleanup which unlinks the socket file
    expect(await probeSocket(socketPath)).not.toBe("alive");
  });
});
