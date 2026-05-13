import { describe, it, expect } from "vitest";
import { spawnSync, execSync } from "node:child_process";
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
  // mirrors pit.ts: uses PI_CODING_AGENT_DIR or ~/.pi/agent
  return process.env.PI_CODING_AGENT_DIR ?? path.join(process.env.HOME!, ".pi", "agent");
}

/**
 * Run a Node.js script inside bwrap using the same mounts pit uses.
 * Returns { stdout, stderr, status }.
 */
function runInBwrap(script: string, extraArgs: string[] = []): {
  stdout: string;
  stderr: string;
  status: number;
} {
  const bwrap = findBwrap();
  if (!bwrap) throw new Error("bwrap not found");

  const nodeBin = process.execPath;
  const nodeDir = path.dirname(path.dirname(nodeBin));
  const agentDir = getAgentDir();
  const worktree = "/tmp";

  const scriptFile = path.join("/tmp", `pit-test-${Date.now()}.mjs`);
  fs.writeFileSync(scriptFile, script);

  try {
    const args = [
      "--tmpfs", "/",
      "--dev", "/dev",
      "--proc", "/proc",
      "--ro-bind", "/usr", "/usr",
      "--ro-bind", "/etc", "/etc",
      "--ro-bind-try", "/mnt/wsl", "/mnt/wsl",
      "--ro-bind-try", "/lib", "/lib",
      "--ro-bind-try", "/lib64", "/lib64",
      "--ro-bind-try", "/bin", "/bin",
      "--ro-bind-try", "/sbin", "/sbin",
      "--ro-bind", nodeDir, nodeDir,
      "--bind", agentDir, agentDir,
      "--bind", worktree, worktree,
      ...extraArgs,
      "--unshare-user",
      "--unshare-pid",
      "--die-with-parent",
      "--setenv", "HOME", process.env.HOME!,
      "--setenv", "PATH", `${nodeDir}/bin:/usr/local/bin:/usr/bin:/bin`,
      "--chdir", worktree,
      "--",
      nodeBin, scriptFile,
    ];

    const result = spawnSync(bwrap, args, { encoding: "utf8", timeout: 15000 });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      status: result.status ?? 1,
    };
  } finally {
    fs.rmSync(scriptFile, { force: true });
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("pit bwrap sandbox", () => {
  const hasBwrap = !!findBwrap();

  it.skipIf(!hasBwrap)("resolves DNS inside bwrap", () => {
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
    const result = runInBwrap(`
      import { readFileSync, writeFileSync } from "node:fs";
      const authFile = process.env.HOME + "/.pi/agent/auth.json";
      // readable
      const content = readFileSync(authFile, "utf8");
      const data = JSON.parse(content);
      process.stdout.write(JSON.stringify({ providers: Object.keys(data) }));
      // writable — write the same content back (no-op change)
      writeFileSync(authFile, content, "utf8");
    `);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    const { providers } = JSON.parse(result.stdout);
    expect(providers.length).toBeGreaterThan(0);
  });

  it.skipIf(!hasBwrap)("models are available via SDK inside bwrap", () => {
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
    expect(count, "no models available — auth likely not loading inside bwrap").toBeGreaterThan(0);
  });
});
