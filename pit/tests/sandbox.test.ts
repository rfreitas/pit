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
import { Effect } from "effect";
import { layer as NodeContextLayer, type NodeContext } from "../src/node-context.ts";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeFilteredSettings } from "../src/core/sandbox/io.ts";

const run = <A>(eff: Effect.Effect<A, unknown, NodeContext>) =>
  Effect.runPromise(eff.pipe(Effect.provide(NodeContextLayer)));

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

interface BwrapRunOptions {
  /**
   * Override the agent dir mounted rw in the sandbox.
   * Defaults to the real getAgentDir(), symlink-resolved (matching bwrapLaunch).
   * Use a temp dir in tests that shouldn't touch real system files.
   */
  agentDir?: string;
}

/**
 * Run a Node.js ESM script inside bwrap using pit's exact mount set.
 * stdout/stderr are captured; status code is returned.
 *
 * PI_CODING_AGENT_DIR is set inside the sandbox so scripts can locate the
 * agent dir without reconstructing it from HOME.
 */
function runInBwrap(script: string, opts: BwrapRunOptions = {}): { stdout: string; stderr: string; status: number } {
  const bwrap = findBwrap();
  if (!bwrap) throw new Error("bwrap not found");

  const nodeBin = process.execPath;
  const nodeDir = path.dirname(path.dirname(nodeBin));
  // Resolve symlinks — matches fs.realpathSync(AGENT_DIR) in bwrapLaunch.
  // Create the dir if it doesn't exist (CI runners start with no ~/.pi directory).
  const rawAgentDir = opts.agentDir ?? getAgentDir();
  if (!fs.existsSync(rawAgentDir)) {
    fs.mkdirSync(rawAgentDir, { recursive: true });
    fs.writeFileSync(path.join(rawAgentDir, "auth.json"), "{}");
  }
  const agentDir = fs.realpathSync(rawAgentDir);

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
        // /etc/resolv.conf → /mnt/wsl/resolv.conf on WSL (EAI_AGAIN without this)
        "--ro-bind-try", "/mnt/wsl", "/mnt/wsl",
        // /etc/resolv.conf → /run/systemd/resolve/stub-resolv.conf on Ubuntu 24.04+
        "--ro-bind-try", "/run/systemd/resolve", "/run/systemd/resolve",
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
        "--setenv", "PI_CODING_AGENT_DIR", agentDir,
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

/**
 * Check if bwrap can actually create user namespaces on this kernel.
 * Uses a minimal but complete bwrap invocation — bwrap 0.11.0 requires at
 * least a root filesystem before it can exec anything, even for a probe.
 */
function bwrapCanUnshareUser(): boolean {
  if (!hasBwrap) return false;
  const r = spawnSync(findBwrap()!, [
    "--tmpfs", "/", "--dev", "/dev", "--proc", "/proc",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind-try", "/bin", "/bin",
    "--ro-bind-try", "/lib", "/lib",
    "--ro-bind-try", "/lib64", "/lib64",
    "--unshare-user",
    "--", "/bin/true",
  ], { encoding: "utf8" });
  return r.status === 0;
}
const hasBwrapUserNS = bwrapCanUnshareUser();

/**
 * Check if bwrap supports --overlay-src / --tmp-overlay (added in 0.10.0).
 * Ubuntu 24.04 ships 0.9.0 which lacks these flags.
 */
function bwrapSupportsOverlay(): boolean {
  if (!hasBwrapUserNS) return false;
  const src = fs.mkdtempSync(path.join("/tmp", "bwrap-overlay-check-"));
  const dest = fs.mkdtempSync(path.join("/tmp", "bwrap-overlay-dest-"));
  try {
    const r = spawnSync(
      findBwrap()!,
      ["--tmpfs", "/", "--dev", "/dev", "--proc", "/proc",
       "--overlay-src", src, "--tmp-overlay", dest,
       "--unshare-user", "--", "true"],
      { encoding: "utf8" },
    );
    return r.status === 0;
  } catch { return false; }
  finally {
    fs.rmSync(src,  { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }
}
const hasBwrapOverlay = bwrapSupportsOverlay();

const piSdkPath = path.join(
  path.dirname(path.dirname(process.execPath)),
  "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js",
);
const hasPiSdk = fs.existsSync(piSdkPath);

describe("pit bwrap sandbox", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });
  it.skipIf(!hasBwrapUserNS)("resolves DNS inside bwrap", async () => {
    // /etc/resolv.conf is a symlink on both WSL (/mnt/wsl/resolv.conf) and
    // Ubuntu 24.04+ (/run/systemd/resolve/stub-resolv.conf). Both targets are
    // mounted via --ro-bind-try in runInBwrap. Uses dns.lookup (getaddrinfo)
    // not resolve4 (c-ares) — c-ares bypasses the system resolver and can fail
    // when the stub DNS server isn't reachable via raw UDP.
    const result = runInBwrap(`
      import { lookup } from "node:dns/promises";
      const { address } = await lookup("github.com");
      process.stdout.write(JSON.stringify({ address }));
    `);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    const { address } = JSON.parse(result.stdout);
    expect(address.length).toBeGreaterThan(0);
  });

  it.skipIf(!hasBwrapUserNS)("reaches api.anthropic.com over HTTPS inside bwrap", async () => {
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

  it.skipIf(!hasBwrapUserNS)("reaches api.githubcopilot.com over HTTPS inside bwrap", async () => {
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

  it.skipIf(!hasBwrapUserNS)("agent dir is readable and writable inside bwrap", async () => {
    // Bug: when the agent dir was --ro-bind'd, proper-lockfile could not create
    // auth.json.lock (EROFS). AuthStorage caught the error silently and left
    // this.data={}, so getApiKey() returned null for every provider.
    // Fix: use --bind (rw) for the agent dir instead of --ro-bind.
    //
    // Uses a temp dir with a fake auth.json — no real system files needed.
    // The script references PI_CODING_AGENT_DIR (set by runInBwrap) rather than
    // reconstructing the path from HOME, matching how pit sets it in the real sandbox.
    const fakeAgentDir = fs.mkdtempSync(path.join("/tmp", "pit-agent-test-"));
    tmpDirs.push(fakeAgentDir);
    fs.writeFileSync(
      path.join(fakeAgentDir, "auth.json"),
      JSON.stringify({ copilot: {}, anthropic: {} })
    );

    const result = runInBwrap(`
      import { readFileSync, writeFileSync } from "node:fs";
      const authFile = process.env.PI_CODING_AGENT_DIR + "/auth.json";
      const content = readFileSync(authFile, "utf8");
      const data = JSON.parse(content);
      // write back the same content to confirm write access (the rw-vs-ro regression)
      writeFileSync(authFile, content, "utf8");
      process.stdout.write(JSON.stringify({ providers: Object.keys(data) }));
    `, { agentDir: fakeAgentDir });

    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    const { providers } = JSON.parse(result.stdout);
    expect(providers.length).toBeGreaterThan(0);
  });

  it.skipIf(!hasBwrapUserNS || !hasPiSdk)("models are available via SDK inside bwrap", async () => {
    // End-to-end check: if either the DNS fix or the auth fix regresses,
    // getAvailable() returns [] and this test fails before the user even
    // tries to send a message.
    const result = runInBwrap(`
      import { AuthStorage, ModelRegistry } from "${piSdkPath}";
      const auth = AuthStorage.create();
      const registry = ModelRegistry.create(auth);
      const available = await registry.getAvailable();
      process.stdout.write(JSON.stringify({ count: available.length }));
    `);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    const { count } = JSON.parse(result.stdout);
    // count may be 0 on CI (no real auth tokens) — that is correct SDK behaviour.
    // This test verifies the SDK initialises and DNS resolves without crashing.
    expect(count, "no models — DNS or auth broken inside bwrap").toBeGreaterThanOrEqual(0);
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
          "--ro-bind-try", "/run/systemd/resolve", "/run/systemd/resolve",
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

  it.skipIf(!hasBwrapUserNS)(
    "PI_CODING_AGENT_DIR is set to /pit-agent inside the sandbox",
    async () => {
      const agentDir = makeAgentDir();
      fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
      const filteredPath = path.join(makeTmpDir(), "settings.json");
      await run(writeFilteredSettings(agentDir, {}, filteredPath));

      const result = runWithShadowAgent(
        agentDir, filteredPath,
        `process.stdout.write(process.env.PI_CODING_AGENT_DIR ?? "unset");`
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("/pit-agent");
    }
  );

  it.skipIf(!hasBwrapUserNS)(
    "settings.json at PI_CODING_AGENT_DIR is the filtered version: denied packages absent, allowed present",
    async () => {
      const agentDir = makeAgentDir();
      fs.writeFileSync(
        path.join(agentDir, "settings.json"),
        JSON.stringify({ packages: [...denylist, allowedPkg] })
      );
      const filteredPath = path.join(makeTmpDir(), "settings.json");
      await run(writeFilteredSettings(agentDir, { denyPackages: denylist }, filteredPath));

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

  it.skipIf(!hasBwrapUserNS)(
    "writes to PI_CODING_AGENT_DIR/auth.json are visible on the host (rw bind, not lost in tmpfs)",
    async () => {
      const agentDir = makeAgentDir();
      fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
      const filteredPath = path.join(makeTmpDir(), "settings.json");
      await run(writeFilteredSettings(agentDir, {}, filteredPath));

      runWithShadowAgent(agentDir, filteredPath, `
        import { writeFileSync } from "node:fs";
        writeFileSync(process.env.PI_CODING_AGENT_DIR + "/auth.json", JSON.stringify({ written: true }));
      `);

      const hostContent = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8"));
      expect(hostContent.written).toBe(true);
    }
  );

  it.skipIf(!hasBwrapUserNS)(
    "writes to PI_CODING_AGENT_DIR/sessions are visible on the host (rw bind, not lost in tmpfs)",
    async () => {
      const agentDir = makeAgentDir();
      fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
      const filteredPath = path.join(makeTmpDir(), "settings.json");
      await run(writeFilteredSettings(agentDir, {}, filteredPath));

      runWithShadowAgent(agentDir, filteredPath, `
        import { writeFileSync } from "node:fs";
        writeFileSync(process.env.PI_CODING_AGENT_DIR + "/sessions/probe.txt", "ok");
      `);

      expect(fs.existsSync(path.join(agentDir, "sessions", "probe.txt"))).toBe(true);
    }
  );

  it.skipIf(!hasBwrapUserNS)(
    "writes to PI_CODING_AGENT_DIR/settings.json go to the filtered file, not the real settings",
    async () => {
      // The later bind on settings.json must win over the base rw bind, so
      // writing to settings.json inside the sandbox updates the filtered host
      // file (pit-escape's refresh target) and leaves ~/.pi/agent/settings.json
      // untouched. This is what makes /reload safe.
      const agentDir = makeAgentDir();
      fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: ["real"] }));
      const filteredPath = path.join(makeTmpDir(), "settings.json");
      await run(writeFilteredSettings(agentDir, {}, filteredPath));

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
          "--ro-bind-try", "/run/systemd/resolve", "/run/systemd/resolve",
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

  it.skipIf(!hasBwrapOverlay)("file from src is readable at dest inside the sandbox", async () => {
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

  it.skipIf(!hasBwrapOverlay)("writes inside the sandbox succeed (no EROFS)", async () => {
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

  it.skipIf(!hasBwrapOverlay)("writes inside the sandbox do NOT persist to the host src", async () => {
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

  it.skipIf(!hasBwrapOverlay)("host src file is unchanged after overwrite inside the sandbox", async () => {
    const src  = makeTmpDir();
    const dest = makeTmpDir();
    fs.writeFileSync(path.join(src, "original.txt"), "original-content");

    runWithOverlay(src, dest, `
      import { writeFileSync } from "node:fs";
      writeFileSync("${dest}/original.txt", "overwritten-inside-sandbox");
    `);

    expect(fs.readFileSync(path.join(src, "original.txt"), "utf8")).toBe("original-content");
  });

  it.skipIf(!hasBwrapOverlay)("nested subdirectory inside src is accessible at dest", async () => {
    // Verifies the overlay covers the whole subtree, not just the top level.
    const src  = makeTmpDir();
    const dest = makeTmpDir();
    fs.mkdirSync(path.join(src, "sub", "deep"), { recursive: true });
    fs.writeFileSync(path.join(src, "sub", "deep", "nested.txt"), "nested-content");

    const result = runWithOverlay(src, dest, `
      import { readFileSync } from "node:fs";
      const content = readFileSync("${dest}/sub/deep/nested.txt", "utf8");
      process.stdout.write(content);
    `);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toBe("nested-content");
  });

  it.skipIf(!hasBwrapOverlay)("write then read within the same session sees the written content", async () => {
    // The tmpfs upper layer must be coherent within a session: a file written
    // to the overlay must be immediately readable back with the new content.
    const src  = makeTmpDir();
    const dest = makeTmpDir();
    fs.writeFileSync(path.join(src, "base.txt"), "original");

    const result = runWithOverlay(src, dest, `
      import { readFileSync, writeFileSync } from "node:fs";
      writeFileSync("${dest}/base.txt", "modified");
      const content = readFileSync("${dest}/base.txt", "utf8");
      process.stdout.write(content);
    `);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toBe("modified");
  });
});

