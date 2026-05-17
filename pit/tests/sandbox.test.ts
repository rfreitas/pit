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
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeFilteredSettings } from "../utils.ts";

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

// ── shadow agent dir ────────────────────────────────────────────────────────
//
// These tests verify that the bwrap mount configuration for the shadow agent
// dir is wired correctly. They don't test the filtering logic (covered by
// unit and pit-escape tests) — they test whether the cage was built right:
// correct source paths, correct destination, correct bind order (rw beats ro),
// and correct PI_CODING_AGENT_DIR env var.

describe("shadow agent dir bwrap wiring", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  // Use /tmp for all temp dirs — it's already mounted rw in the bwrap sandbox.
  function makeTmpDir(): string {
    const d = fs.mkdtempSync(path.join("/tmp", "pit-shadow-test-"));
    tmpDirs.push(d);
    return d;
  }

  const denylist = ["npm:@casualjim/pi-heimdall", "npm:@spences10/pi-confirm-destructive"];
  const allowedPkg = "npm:pi-agent-browser-native";

  /**
   * Run a Node.js ESM script inside bwrap with the shadow agent dir mounted.
   * agentDir             — fake ~/.pi/agent (rw bind base)
   * filteredSettingsPath — pre-written filtered settings.json (rw bind, overrides base)
   */
  function runWithShadowAgent(
    agentDir: string,
    filteredSettingsPath: string,
    script: string
  ): { stdout: string; stderr: string; status: number } {
    const bwrap = findBwrap()!;
    const nodeBin = process.execPath;
    const nodeDir = path.dirname(path.dirname(nodeBin));
    const scriptFile = path.join("/tmp", `shadow-test-${Date.now()}.mjs`);
    fs.writeFileSync(scriptFile, script);

    try {
      const result = spawnSync(
        bwrap,
        [
          "--tmpfs", "/",
          "--dev",   "/dev",
          "--proc",  "/proc",
          "--ro-bind",     "/usr",     "/usr",
          "--ro-bind",     "/etc",     "/etc",
          "--ro-bind-try", "/mnt/wsl", "/mnt/wsl",
          "--ro-bind-try", "/lib",     "/lib",
          "--ro-bind-try", "/lib64",   "/lib64",
          "--ro-bind-try", "/bin",     "/bin",
          "--ro-bind-try", "/sbin",    "/sbin",
          "--ro-bind",     nodeDir,    nodeDir,
          "--bind",        "/tmp",     "/tmp",
          // Shadow agent dir: rw bind so proper-lockfile can create lock files
          // (auth.json.lock etc.) next to auth.json. Later bind overrides settings.json.
          "--bind", agentDir,             "/pit-agent",
          "--bind", filteredSettingsPath, "/pit-agent/settings.json",
          "--unshare-user",
          "--unshare-pid",
          "--die-with-parent",
          "--setenv", "HOME",                process.env.HOME!,
          "--setenv", "PATH",                `${nodeDir}/bin:/usr/local/bin:/usr/bin:/bin`,
          "--setenv", "PI_CODING_AGENT_DIR", "/pit-agent",
          "--chdir",  "/tmp",
          "--",
          nodeBin, scriptFile,
        ],
        { encoding: "utf8", timeout: 10000 }
      );
      return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
    } finally {
      fs.rmSync(scriptFile, { force: true });
    }
  }

  function makeAgentDir() {
    const agentDir = makeTmpDir();
    fs.writeFileSync(path.join(agentDir, "auth.json"), "{}");
    fs.mkdirSync(path.join(agentDir, "sessions"));
    return agentDir;
  }

  it.skipIf(!hasBwrap)(
    "PI_CODING_AGENT_DIR is set to /pit-agent inside the sandbox",
    () => {
      const agentDir = makeAgentDir();
      fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
      const filteredPath = path.join(makeTmpDir(), "settings.json");
      writeFilteredSettings(agentDir, {}, filteredPath);

      const result = runWithShadowAgent(
        agentDir, filteredPath,
        `process.stdout.write(process.env.PI_CODING_AGENT_DIR ?? "unset");`
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("/pit-agent");
    }
  );

  it.skipIf(!hasBwrap)(
    "settings.json at PI_CODING_AGENT_DIR is the filtered version: denied packages absent, allowed present",
    () => {
      const agentDir = makeAgentDir();
      fs.writeFileSync(
        path.join(agentDir, "settings.json"),
        JSON.stringify({ packages: [...denylist, allowedPkg] })
      );
      const filteredPath = path.join(makeTmpDir(), "settings.json");
      writeFilteredSettings(agentDir, { denyPackages: denylist }, filteredPath);

      const result = runWithShadowAgent(agentDir, filteredPath, `
        import { readFileSync } from "node:fs";
        const s = JSON.parse(readFileSync(process.env.PI_CODING_AGENT_DIR + "/settings.json", "utf8"));
        process.stdout.write(JSON.stringify(s.packages));
      `);
      expect(result.status, result.stderr).toBe(0);
      const packages: string[] = JSON.parse(result.stdout);
      for (const p of ["npm:@casualjim/pi-heimdall", "npm:@spences10/pi-confirm-destructive"]) {
        expect(packages).not.toContain(p);
      }
      expect(packages).toContain(allowedPkg);
    }
  );

  it.skipIf(!hasBwrap)(
    "writes to PI_CODING_AGENT_DIR/auth.json are visible on the host (rw bind, not lost in tmpfs)",
    () => {
      const agentDir = makeAgentDir();
      fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
      const filteredPath = path.join(makeTmpDir(), "settings.json");
      writeFilteredSettings(agentDir, {}, filteredPath);

      runWithShadowAgent(agentDir, filteredPath, `
        import { writeFileSync } from "node:fs";
        writeFileSync(process.env.PI_CODING_AGENT_DIR + "/auth.json", JSON.stringify({ written: true }));
      `);

      const hostContent = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8"));
      expect(hostContent.written).toBe(true);
    }
  );

  it.skipIf(!hasBwrap)(
    "writes to PI_CODING_AGENT_DIR/sessions are visible on the host (rw bind, not lost in tmpfs)",
    () => {
      const agentDir = makeAgentDir();
      fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
      const filteredPath = path.join(makeTmpDir(), "settings.json");
      writeFilteredSettings(agentDir, {}, filteredPath);

      runWithShadowAgent(agentDir, filteredPath, `
        import { writeFileSync } from "node:fs";
        writeFileSync(process.env.PI_CODING_AGENT_DIR + "/sessions/probe.txt", "ok");
      `);

      expect(fs.existsSync(path.join(agentDir, "sessions", "probe.txt"))).toBe(true);
    }
  );

  it.skipIf(!hasBwrap)(
    "writes to PI_CODING_AGENT_DIR/settings.json go to the filtered file, not the real settings",
    () => {
      // The later bind on settings.json must win over the base rw bind, so
      // writing to settings.json inside the sandbox updates the filtered host
      // file (pit-escape's refresh target) and leaves ~/.pi/agent/settings.json
      // untouched. This is what makes /reload safe.
      const agentDir = makeAgentDir();
      fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: ["real"] }));
      const filteredPath = path.join(makeTmpDir(), "settings.json");
      writeFilteredSettings(agentDir, {}, filteredPath);

      runWithShadowAgent(agentDir, filteredPath, `
        import { writeFileSync } from "node:fs";
        writeFileSync(process.env.PI_CODING_AGENT_DIR + "/settings.json", JSON.stringify({ packages: ["written"] }));
      `);

      // Filtered file updated
      expect(JSON.parse(fs.readFileSync(filteredPath, "utf8")).packages).toEqual(["written"]);
      // Real settings untouched
      expect(JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")).packages).toEqual(["real"]);
    }
  );
});

// ── tmp-overlay mounts ────────────────────────────────────────────────────────
//
// Verifies that --tmp-overlay gives the sandbox a writable view of an
// unversioned parent directory:
//   • files from the lower (parent) dir are readable at the dest path
//   • writes inside the sandbox succeed (no EROFS)
//   • those writes do NOT persist to the real source or dest on the host

describe("tmp-overlay sandbox mounts", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  function makeTmpDir(): string {
    const d = fs.mkdtempSync(path.join("/tmp", "pit-overlay-test-"));
    tmpDirs.push(d);
    return d;
  }

  /**
   * Run a Node.js script inside bwrap with one --tmp-overlay mount:
   *   src  → lower (read-only) layer (the parent repo dir)
   *   dest → where it appears in the sandbox (must already exist as a dir)
   */
  function runWithOverlay(
    src: string,
    dest: string,
    script: string,
  ): { stdout: string; stderr: string; status: number } {
    const bwrap = findBwrap()!;
    const nodeBin = process.execPath;
    const nodeDir = path.dirname(path.dirname(nodeBin));
    const scriptFile = path.join("/tmp", `pit-overlay-script-${Date.now()}.mjs`);
    fs.writeFileSync(scriptFile, script);
    try {
      const result = spawnSync(
        bwrap,
        [
          "--tmpfs",       "/",
          "--dev",         "/dev",
          "--proc",        "/proc",
          "--ro-bind",     "/usr",    "/usr",
          "--ro-bind",     "/etc",    "/etc",
          "--ro-bind-try", "/mnt/wsl", "/mnt/wsl",
          "--ro-bind-try", "/lib",    "/lib",
          "--ro-bind-try", "/lib64",  "/lib64",
          "--ro-bind-try", "/bin",    "/bin",
          "--ro-bind-try", "/sbin",   "/sbin",
          "--ro-bind",     nodeDir,   nodeDir,
          "--bind",        "/tmp",    "/tmp",
          // dest is inside /tmp (already rw-bound above).
          // Syntax: --overlay-src <lower> --tmp-overlay <dest>
          "--overlay-src", src, "--tmp-overlay", dest,
          "--unshare-user",
          "--unshare-pid",
          "--die-with-parent",
          "--setenv", "HOME", process.env.HOME!,
          "--setenv", "PATH", `${nodeDir}/bin:/usr/local/bin:/usr/bin:/bin`,
          "--chdir", "/tmp",
          "--",
          nodeBin, scriptFile,
        ],
        { encoding: "utf8", timeout: 10000 },
      );
      return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
    } finally {
      fs.rmSync(scriptFile, { force: true });
    }
  }

  it.skipIf(!hasBwrap)("file from src is readable at dest inside the sandbox", () => {
    const src  = makeTmpDir(); // lower layer (parent repo dir)
    const dest = makeTmpDir(); // mount point (worktree dir, must pre-exist)
    fs.writeFileSync(path.join(src, "sentinel.txt"), "hello-from-parent");

    const result = runWithOverlay(src, dest, `
      import { readFileSync } from "node:fs";
      const content = readFileSync("${dest}/sentinel.txt", "utf8");
      process.stdout.write(content);
    `);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toBe("hello-from-parent");
  });

  it.skipIf(!hasBwrap)("writes inside the sandbox succeed (no EROFS)", () => {
    const src  = makeTmpDir();
    const dest = makeTmpDir();

    const result = runWithOverlay(src, dest, `
      import { writeFileSync } from "node:fs";
      writeFileSync("${dest}/written.txt", "sandbox-write");
      process.stdout.write("ok");
    `);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  it.skipIf(!hasBwrap)("writes inside the sandbox do NOT persist to the host src", () => {
    const src  = makeTmpDir();
    const dest = makeTmpDir();

    runWithOverlay(src, dest, `
      import { writeFileSync } from "node:fs";
      writeFileSync("${dest}/ephemeral.txt", "should-not-persist");
    `);

    // Must not appear in the real src (lower layer) or the real dest (mount point)
    expect(fs.existsSync(path.join(src,  "ephemeral.txt"))).toBe(false);
    expect(fs.existsSync(path.join(dest, "ephemeral.txt"))).toBe(false);
  });

  it.skipIf(!hasBwrap)("host src file is unchanged after overwrite inside the sandbox", () => {
    const src  = makeTmpDir();
    const dest = makeTmpDir();
    fs.writeFileSync(path.join(src, "original.txt"), "original-content");

    runWithOverlay(src, dest, `
      import { writeFileSync } from "node:fs";
      writeFileSync("${dest}/original.txt", "overwritten-inside-sandbox");
    `);

    expect(fs.readFileSync(path.join(src, "original.txt"), "utf8")).toBe("original-content");
  });
});

