/**
 * Integration tests for pit's bwrap sandbox environment.
 *
 * These tests run real code inside a bwrap namespace with the exact same
 * mounts that pit uses, catching environment issues that only surface
 * inside the sandbox.
 *
 * Bugs caught by these tests:
 *
 *   DNS broken  — /etc/resolv.conf on WSL is a symlink to /mnt/wsl/resolv.conf.
 *                 Without mounting /mnt/wsl, the symlink is dangling inside bwrap
 *                 and all DNS lookups fail with EAI_AGAIN. pi reports this as
 *                 "Connection error" when the user sends the first message.
 *
 *   Auth broken — pi uses proper-lockfile to lock auth.json before reading it.
 *                 The lock is created as auth.json.lock next to auth.json.
 *                 When the agent dir was --ro-bind'd, that mkdir failed (EROFS),
 *                 AuthStorage silently swallowed the error and left this.data={},
 *                 causing getApiKey() to return null for every provider.
 *                 pi reported "No models available" on startup.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ── helpers ───────────────────────────────────────────────────────────────────

function findBwrap(): string | null {
  for (const p of ["/usr/bin/bwrap", "/usr/local/bin/bwrap"]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? path.join(process.env.HOME!, ".pi", "agent");
}

/**
 * Run a Node.js ESM script inside bwrap using pit's exact mount set.
 * stdout/stderr are captured; status code is returned.
 */
function runInBwrap(script: string): { stdout: string; stderr: string; status: number } {
  const bwrap = findBwrap();
  if (!bwrap) throw new Error("bwrap not found");

  const nodeBin = process.execPath;
  const nodeDir = path.dirname(path.dirname(nodeBin));
  const agentDir = getAgentDir();

  const scriptFile = path.join("/tmp", `pit-test-${Date.now()}.mjs`);
  fs.writeFileSync(scriptFile, script);

  try {
    const result = spawnSync(
      bwrap,
      [
        "--tmpfs", "/",
        "--dev", "/dev",
        "--proc", "/proc",
        "--ro-bind", "/usr", "/usr",
        "--ro-bind", "/etc", "/etc",
        // /etc/resolv.conf → /mnt/wsl/resolv.conf on WSL; must be mounted
        // or DNS fails with EAI_AGAIN inside the sandbox.
        "--ro-bind-try", "/mnt/wsl", "/mnt/wsl",
        "--ro-bind-try", "/lib", "/lib",
        "--ro-bind-try", "/lib64", "/lib64",
        "--ro-bind-try", "/bin", "/bin",
        "--ro-bind-try", "/sbin", "/sbin",
        "--ro-bind", nodeDir, nodeDir,
        // agent dir must be rw so proper-lockfile can create auth.json.lock
        "--bind", agentDir, agentDir,
        "--bind", "/tmp", "/tmp",
        "--unshare-user",
        "--unshare-pid",
        "--die-with-parent",
        "--setenv", "HOME", process.env.HOME!,
        "--setenv", "PATH", `${nodeDir}/bin:/usr/local/bin:/usr/bin:/bin`,
        "--chdir", "/tmp",
        "--",
        nodeBin, scriptFile,
      ],
      { encoding: "utf8", timeout: 15000 }
    );
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
  } finally {
    fs.rmSync(scriptFile, { force: true });
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

const hasBwrap = !!findBwrap();

describe("pit bwrap sandbox", () => {
  it.skipIf(!hasBwrap)("resolves DNS inside bwrap", () => {
    // Bug: /etc/resolv.conf is a symlink to /mnt/wsl/resolv.conf on WSL.
    // Without --ro-bind-try /mnt/wsl /mnt/wsl the symlink is dangling and
    // all DNS queries fail. Fix: mount /mnt/wsl inside the sandbox.
    const result = runInBwrap(`
      import { resolve4 } from "node:dns/promises";
      const addrs = await resolve4("github.com");
      process.stdout.write(JSON.stringify({ addrs }));
    `);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    const { addrs } = JSON.parse(result.stdout);
    expect(addrs.length).toBeGreaterThan(0);
  });

  it.skipIf(!hasBwrap)("reaches api.anthropic.com over HTTPS inside bwrap", () => {
    // Verifies that fixing DNS also unblocks outbound HTTPS to Anthropic's API.
    const result = runInBwrap(`
      import { request } from "node:https";
      await new Promise((resolve, reject) => {
        const req = request(
          { hostname: "api.anthropic.com", path: "/", method: "GET", timeout: 5000 },
          (res) => { res.resume(); resolve(res.statusCode); }
        );
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        req.end();
      });
      process.stdout.write("ok");
    `);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  it.skipIf(!hasBwrap)("reaches api.githubcopilot.com over HTTPS inside bwrap", () => {
    // Verifies connectivity to the GitHub Copilot API (default provider).
    const result = runInBwrap(`
      import { request } from "node:https";
      await new Promise((resolve, reject) => {
        const req = request(
          { hostname: "api.githubcopilot.com", path: "/", method: "GET", timeout: 5000 },
          (res) => { res.resume(); resolve(res.statusCode); }
        );
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        req.end();
      });
      process.stdout.write("ok");
    `);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  it.skipIf(!hasBwrap)("auth.json is readable and writable inside bwrap", () => {
    // Bug: when the agent dir was --ro-bind'd, proper-lockfile could not create
    // auth.json.lock (EROFS). AuthStorage caught the error silently and left
    // this.data={}, so getApiKey() returned null for every provider.
    // Fix: use --bind (rw) for the agent dir instead of --ro-bind.
    const result = runInBwrap(`
      import { readFileSync, writeFileSync } from "node:fs";
      const authFile = process.env.HOME + "/.pi/agent/auth.json";
      const content = readFileSync(authFile, "utf8");
      const data = JSON.parse(content);
      // write back the same content to confirm write access
      writeFileSync(authFile, content, "utf8");
      process.stdout.write(JSON.stringify({ providers: Object.keys(data) }));
    `);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    const { providers } = JSON.parse(result.stdout);
    expect(providers.length).toBeGreaterThan(0);
  });

  it.skipIf(!hasBwrap)("models are available via SDK inside bwrap", () => {
    // End-to-end check: if either the DNS fix or the auth fix regresses,
    // getAvailable() returns [] and this test fails before the user even
    // tries to send a message.
    const nodeDir = path.dirname(path.dirname(process.execPath));
    const pkg = path.join(nodeDir, "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
    const result = runInBwrap(`
      import { AuthStorage, ModelRegistry } from "${pkg}";
      const auth = AuthStorage.create();
      const registry = ModelRegistry.create(auth);
      const available = await registry.getAvailable();
      process.stdout.write(JSON.stringify({ count: available.length }));
    `);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    const { count } = JSON.parse(result.stdout);
    expect(count, "no models — DNS or auth broken inside bwrap").toBeGreaterThan(0);
  });
});
