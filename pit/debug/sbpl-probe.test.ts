/**
 * SBPL research probe — NOT production test code.
 *
 * This file exists to validate understanding of macOS sandbox-exec behaviour
 * before implementing sbpl.ts and sbplLaunch. It uses a test-local
 * buildTestProfile() stand-in instead of the real (not yet written)
 * buildSbplProfile(). Do not add to the vitest include glob or npm test.
 *
 * Run via the dedicated CI job (debug-sbpl-macos) or locally:
 *   npx vitest run pit/debug/sbpl-probe.test.ts --reporter verbose
 *
 * Open questions this file is probing:
 *   - Git spawn: confirmed PATH issue (/opt/homebrew/bin missing) — fix applied, verifying
 *   - DNS: confirmed c-ares vs getaddrinfo split — fix applied (use lookup not resolve4)
 *   - Mach service minimal set (Grill 8): which entries can be safely removed?
 */
import { describe, it, expect, afterEach } from "vitest";
import { Effect } from "effect";
import { NodeContext } from "@effect/platform-node";
import { spawnSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { writeFilteredSettings } from "../src/core/sandbox/io.ts";

const run = <A>(eff: Effect.Effect<A, unknown, NodeContext.NodeContext>) =>
  Effect.runPromise(eff.pipe(Effect.provide(NodeContext.layer)));

// ── platform guard ────────────────────────────────────────────────────────────

const isMacos = process.platform === "darwin";
const hasSandboxExec = isMacos && fs.existsSync("/usr/bin/sandbox-exec");

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? path.join(process.env.HOME!, ".pi", "agent");
}

// ── SBPL profile builder ──────────────────────────────────────────────────────
//
// A test-local profile builder. Not the production buildSbplProfile (which lives
// in src/core/sandbox/sbpl.ts once implemented) — this exists to make tests
// runnable before the production implementation is written and to keep test
// profiles readable and self-contained.
//
// Mach services and IPC requirements are derived from:
//   @anthropic-ai/sandbox-runtime (production Claude Code sandbox)
//   @nqbao/pi-sandbox (pi extension sandbox)
// This is the baseline for Grill 8 validation — trim only with passing tests.

const NODE_MACH_SERVICES = [
  "com.apple.logd",
  "com.apple.system.logger",
  "com.apple.system.opendirectoryd.libinfo",
  "com.apple.system.opendirectoryd.membership",
  "com.apple.bsd.dirhelper",
  "com.apple.securityd.xpc",
  "com.apple.coreservices.launchservicesd",
  "com.apple.FontObjectsServer",
  "com.apple.fonts",
  "com.apple.lsd.mapdb",
  "com.apple.PowerManagement.control",
  "com.apple.system.notification_center",
  "com.apple.SecurityServer",
  "com.apple.cfprefsd.daemon",
  "com.apple.cfprefsd.agent",
  "com.apple.audio.systemsoundserver",
  "com.apple.distributed_notifications@Uv3",
];

const NETWORK_MACH_SERVICES = [
  "com.apple.mDNSResponder",
  "com.apple.mDNSResponderHelper",
  "com.apple.trustd.agent",
];

function esc(p: string): string {
  return JSON.stringify(p);
}

interface TestProfileOptions {
  /** Paths the sandboxed process may read and write. /private/tmp is always included. */
  writePaths?: string[];
  /** Paths the sandboxed process may NOT read (default denylist applied separately). */
  readDenyPaths?: string[];
  /** Whether to allow outbound network. Default: true. */
  network?: boolean;
  /**
   * When true, /private/tmp is NOT added as a default write grant.
   * Use for strict write-containment tests.
   */
  strictWrite?: boolean;
}

function buildTestProfile(opts: TestProfileOptions = {}): string {
  const { writePaths = [], readDenyPaths = [], network = true, strictWrite = false } = opts;
  const machServices = [...NODE_MACH_SERVICES, ...(network ? NETWORK_MACH_SERVICES : [])];

  const lines = [
    "(version 1)",
    "(deny default)",
    "",
    "; reads are globally open — macOS sandbox model, see plans/mac-sandbox.md",
    "(allow file-read*)",
    "",
    "; process",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow process-info* (target same-sandbox))",
    "(allow signal (target same-sandbox))",
    "(allow signal (target children))",
    "",
    "; mach IPC — baseline from ASRT + pi-sandbox (Grill 8)",
    "(allow mach-lookup",
    ...machServices.map((s) => `  (global-name ${esc(s)})`),
    ")",
    "",
    "; POSIX IPC (V8 shared memory, Python multiprocessing)",
    "(allow ipc-posix-shm)",
    "(allow ipc-posix-sem)",
    "",
    "; sysctl (broad allow for test baseline; trim in Grill 8 tests)",
    "(allow sysctl-read)",
    `(allow sysctl-write (sysctl-name "kern.tcsm_enable"))`,
    "",
    "; user preferences + notifications",
    "(allow user-preference-read)",
    "(allow distributed-notification-post)",
    "",
    "; IOKit",
    "(allow iokit-open",
    `  (iokit-registry-entry-class "IOSurfaceRootUserClient")`,
    `  (iokit-registry-entry-class "RootDomainUserClient")`,
    `  (iokit-user-client-class "IOSurfaceSendRight"))`,
    "(allow iokit-get-properties)",
    "",
    "; safe system socket",
    "(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))",
    "",
    "; TTY / pty",
    "(allow pseudo-tty)",
    `(allow file-read* file-write* (literal "/dev/ptmx"))`,
    `(allow file-read* file-write* (regex #"^/dev/ttys"))`,
    `(allow file-ioctl (literal "/dev/null") (literal "/dev/tty") (literal "/dev/ptmx"))`,
    "",
  ];

  if (!strictWrite) {
    lines.push("; /private/tmp writable by default (test scripts live here)");
    lines.push(`(allow file-write* (subpath "/private/tmp"))`);
    lines.push("");
  }

  if (writePaths.length > 0) {
    lines.push("; additional write grants");
    lines.push("(allow file-write*");
    for (const p of writePaths) lines.push(`  (subpath ${esc(p)})`);
    lines.push(")");
    lines.push("");
  }

  if (readDenyPaths.length > 0) {
    lines.push("; read denylist");
    for (const p of readDenyPaths) {
      lines.push(`(deny file-read* (subpath ${esc(p)}))`);
    }
    lines.push("");
  }

  if (network) {
    lines.push("; network");
    lines.push("(allow network*)");
    lines.push("(allow system-socket (socket-domain AF_UNIX))");
    lines.push(`(allow network-outbound (remote unix-socket (path-regex #"^/")))`);
    lines.push(`(allow network-inbound  (local  ip "*:*"))`);
  } else {
    lines.push("; Unix sockets only (for IPC — no TCP)");
    lines.push("(allow system-socket (socket-domain AF_UNIX))");
    lines.push(`(allow network-outbound (remote unix-socket (path-regex #"^/")))`);
  }

  return lines.join("\n");
}

// ── runInSandboxExec ──────────────────────────────────────────────────────────

interface RunOptions extends TestProfileOptions {
  /** Environment for the sandboxed process. Defaults to minimal HOME + PATH. */
  env?: Record<string, string>;
  /** Timeout in ms. Default: 10000. A hang from a missing mach entry shows up here. */
  timeout?: number;
}

/**
 * Write `script` to /private/tmp, run it inside sandbox-exec with a test
 * profile, and return stdout/stderr/status.
 *
 * Uses `sandbox-exec -p <inline-profile>` — no temp profile file needed.
 * The script file is always cleaned up.
 */
function runInSandboxExec(
  script: string,
  opts: RunOptions = {},
): { stdout: string; stderr: string; status: number } {
  const { env, timeout = 10000, ...profileOpts } = opts;
  const profile = buildTestProfile(profileOpts);
  const nodeBin = process.execPath;
  const nodeDir = path.dirname(path.dirname(nodeBin));
  const scriptFile = path.join("/private/tmp", `pit-mac-test-${process.pid}-${Date.now()}.mjs`);
  fs.writeFileSync(scriptFile, script);

  const defaultEnv: Record<string, string> = {
    HOME: process.env.HOME!,
    // Include Homebrew prefix (Apple Silicon /opt/homebrew, Intel /usr/local)
    // so the sandboxed process can find tools like git installed there.
    PATH: `${nodeDir}/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  };

  try {
    const result = spawnSync(
      "/usr/bin/sandbox-exec",
      ["-p", profile, "--", nodeBin, scriptFile],
      { encoding: "utf8", timeout, env: env ?? defaultEnv },
    );
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
  } finally {
    fs.rmSync(scriptFile, { force: true });
  }
}

// ── test workspace ────────────────────────────────────────────────────────────

function makeTmpDir(tmpDirs: string[]): string {
  const d = fs.mkdtempSync(path.join("/private/tmp", "pit-mac-test-"));
  tmpDirs.push(d);
  return d;
}

function makeAgentDir(tmpDirs: string[]): string {
  const agentDir = makeTmpDir(tmpDirs);
  fs.writeFileSync(path.join(agentDir, "auth.json"), "{}");
  fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "bin"),      { recursive: true });
  return agentDir;
}

/**
 * Create a symlink mirror of agentDir at mirrorDir.
 * Each top-level entry in agentDir is symlinked. filteredSettingsPath is
 * hardlinked (not copied) as settings.json — same inode means writes inside
 * the sandbox to PI_CODING_AGENT_DIR/settings.json update the same file that
 * pit-escape reads via filteredSettingsPath. Required for /reload to work.
 */
function createMirror(agentDir: string, mirrorDir: string, filteredSettingsPath: string): void {
  for (const entry of fs.readdirSync(agentDir)) {
    const target = path.join(agentDir, entry);
    const link   = path.join(mirrorDir, entry);
    fs.symlinkSync(target, link);
  }
  // Hardlink settings.json: same inode as filteredSettingsPath, so writes
  // from inside the sandbox are immediately visible via filteredSettingsPath.
  const link = path.join(mirrorDir, "settings.json");
  if (fs.existsSync(link)) fs.unlinkSync(link);
  fs.linkSync(filteredSettingsPath, link);
}

// ── basic sanity ──────────────────────────────────────────────────────────────

describe("sandbox-exec: basic sanity", () => {
  it.skipIf(!hasSandboxExec)("Node.js starts and produces stdout (no mach hang)", () => {
    // A hang from a missing mach entry shows up as a timeout here.
    // timeout: 5s is tight enough to catch hangs without being flaky.
    const result = runInSandboxExec(
      `process.stdout.write("ok");`,
      { timeout: 5000 },
    );
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  it.skipIf(!hasSandboxExec)("stderr is captured", () => {
    const result = runInSandboxExec(`process.stderr.write("err"); process.stdout.write("ok");`);
    expect(result.stdout).toBe("ok");
    expect(result.stderr).toContain("err");
  });

  it.skipIf(!hasSandboxExec)("exit code is forwarded", () => {
    const result = runInSandboxExec(`process.exit(42);`);
    expect(result.status).toBe(42);
  });
});

// ── write containment ─────────────────────────────────────────────────────────

describe("sandbox-exec: write containment", () => {
  it.skipIf(!hasSandboxExec)("can write to an explicitly granted path", () => {
    const tmpDirs: string[] = [];
    afterEach(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

    const dir = makeTmpDir(tmpDirs);
    const result = runInSandboxExec(`
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(path.join(dir, "out.txt"))}, "written");
      process.stdout.write("ok");
    `, { writePaths: [dir] });
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toBe("ok");
    expect(fs.readFileSync(path.join(dir, "out.txt"), "utf8")).toBe("written");
  });

  it.skipIf(!hasSandboxExec)("cannot write outside granted paths (EPERM)", () => {
    // /etc exists and is readable but is not in any write grant.
    const result = runInSandboxExec(`
      import { writeFileSync } from "node:fs";
      try {
        writeFileSync("/etc/pit-sandbox-test", "bad");
        process.stdout.write("wrote");
      } catch (e) {
        process.stdout.write(e.code ?? "error");
      }
    `, { strictWrite: true });
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/EPERM|EACCES|EROFS/);
  });

  it.skipIf(!hasSandboxExec)("cannot write to home directory (not in grants)", () => {
    const result = runInSandboxExec(`
      import { writeFileSync } from "node:fs";
      import { homedir } from "node:os";
      try {
        writeFileSync(homedir() + "/pit-sandbox-test-should-not-exist", "bad");
        process.stdout.write("wrote");
      } catch (e) {
        process.stdout.write(e.code ?? "error");
      }
    `, { strictWrite: true });
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/EPERM|EACCES/);
  });

  it.skipIf(!hasSandboxExec)("writes to granted path persist to the host", () => {
    const tmpDirs: string[] = [];
    const dir = makeTmpDir(tmpDirs);
    afterEach(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

    runInSandboxExec(`
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(path.join(dir, "persist.txt"))}, "persisted");
    `, { writePaths: [dir] });
    expect(fs.readFileSync(path.join(dir, "persist.txt"), "utf8")).toBe("persisted");
  });
});

// ── read policy ───────────────────────────────────────────────────────────────

describe("sandbox-exec: read policy", () => {
  it.skipIf(!hasSandboxExec)("reads are globally open (can read arbitrary system paths)", () => {
    // Unlike bwrap, reads are not restricted on macOS. The agent can read
    // any file not in the denylist.
    const result = runInSandboxExec(`
      import { readFileSync } from "node:fs";
      const content = readFileSync("/etc/hosts", "utf8");
      process.stdout.write(content.length > 0 ? "ok" : "empty");
    `);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  it.skipIf(!hasSandboxExec)("denied read path returns EPERM / EACCES", () => {
    const deniedDir = path.join(process.env.HOME!, ".ssh");
    // Skip if the directory does not exist on this machine
    if (!fs.existsSync(deniedDir)) return;

    const result = runInSandboxExec(`
      import { readdirSync } from "node:fs";
      try {
        readdirSync(${JSON.stringify(deniedDir)});
        process.stdout.write("read");
      } catch (e) {
        process.stdout.write(e.code ?? "error");
      }
    `, { readDenyPaths: [deniedDir] });
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/EPERM|EACCES/);
  });

  it.skipIf(!hasSandboxExec)("default credential denylist blocks ~/.ssh", () => {
    const sshDir = path.join(process.env.HOME!, ".ssh");
    if (!fs.existsSync(sshDir)) return;

    // Use the default credential denylist (same as buildSandboxMountSpec darwin)
    const defaultDenyPaths = [
      path.join(process.env.HOME!, ".ssh"),
      path.join(process.env.HOME!, ".aws"),
      path.join(process.env.HOME!, ".gnupg"),
    ];
    const result = runInSandboxExec(`
      import { readdirSync } from "node:fs";
      try {
        readdirSync(${JSON.stringify(sshDir)});
        process.stdout.write("read");
      } catch (e) {
        process.stdout.write(e.code ?? "error");
      }
    `, { readDenyPaths: defaultDenyPaths });
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/EPERM|EACCES/);
  });

  it.skipIf(!hasSandboxExec)("path not in denylist is readable even if sensitive-sounding", () => {
    // Reads outside the denylist are open — this is a documented difference
    // from the Linux bwrap model (see plans/mac-sandbox.md, closed filesystem).
    const result = runInSandboxExec(`
      import { readFileSync } from "node:fs";
      try {
        // /etc/passwd exists on macOS, is not in the denylist
        const content = readFileSync("/etc/passwd", "utf8");
        process.stdout.write(content.length > 0 ? "readable" : "empty");
      } catch (e) {
        process.stdout.write(e.code ?? "error");
      }
    `);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toBe("readable");
  });

  it.skipIf(!hasSandboxExec)("allowRead exception carves a path back out of denylist", () => {
    const allowedFile = path.join("/private/tmp", `pit-allowread-test-${process.pid}.txt`);
    fs.writeFileSync(allowedFile, "allowed-content");

    // Deny all of /private/tmp, then carve back the specific file.
    // SBPL last-match-wins: deny subpath first, allow literal last.
    const profile = buildTestProfile({}) +
      `\n(deny file-read* (subpath "/private/tmp"))\n(allow file-read* (literal ${esc(allowedFile)}))`;

    // Script file must NOT be in /private/tmp — it would be denied by the rule above.
    // os.tmpdir() on macOS returns /var/folders/… which is a different path.
    const scriptFile = path.join(os.tmpdir(), `pit-re-allow-${process.pid}.mjs`);
    fs.writeFileSync(scriptFile, `
      import { readFileSync } from "node:fs";
      try {
        const c = readFileSync(${JSON.stringify(allowedFile)}, "utf8");
        process.stdout.write(c);
      } catch (e) {
        process.stdout.write(e.code ?? "error");
      }
    `);

    try {
      const result = spawnSync(
        "/usr/bin/sandbox-exec",
        ["-p", profile, "--", process.execPath, scriptFile],
        {
          encoding: "utf8",
          timeout: 10000,
          env: { HOME: process.env.HOME!, PATH: process.env.PATH! },
        },
      );
      // Validates SBPL last-match-wins: (allow literal) after (deny subpath) wins.
      // If this fails, the sandbox.allowRead exception mechanism won’t work.
      expect(result.stdout, `stderr: ${result.stderr}`).toBe("allowed-content");
    } finally {
      fs.rmSync(scriptFile, { force: true });
      fs.rmSync(allowedFile, { force: true });
    }
  });
});

// ── env seal ──────────────────────────────────────────────────────────────────

describe("sandbox-exec: env seal", () => {
  it.skipIf(!hasSandboxExec)("HOME is present in the sealed environment", () => {
    const result = runInSandboxExec(
      `process.stdout.write(process.env.HOME ?? "missing");`,
      { env: { HOME: process.env.HOME!, PATH: "/usr/bin:/bin" } },
    );
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toBe(process.env.HOME);
  });

  it.skipIf(!hasSandboxExec)("variable not in the allowlist is absent", () => {
    const result = runInSandboxExec(
      `process.stdout.write(process.env.SECRET_TOKEN ?? "absent");`,
      { env: { HOME: process.env.HOME!, PATH: "/usr/bin:/bin" } },
    );
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    // SECRET_TOKEN was not passed in env — it must not leak from the outer env
    expect(result.stdout).toBe("absent");
  });

  it.skipIf(!hasSandboxExec)("sensitive var set in outer env does not reach sandbox", () => {
    // Simulate a shell with a credential variable set. It must not be visible
    // inside the sandbox because env is explicitly constructed.
    const outerEnvWithSecret = {
      ...process.env,
      AWS_SECRET_ACCESS_KEY: "super-secret-do-not-leak",
    } as Record<string, string>;

    // The sealed env intentionally omits AWS_SECRET_ACCESS_KEY
    const sealedEnv: Record<string, string> = {
      HOME: process.env.HOME!,
      PATH: `${path.dirname(path.dirname(process.execPath))}/bin:/usr/local/bin:/usr/bin:/bin`,
    };

    const result = runInSandboxExec(
      `process.stdout.write(process.env.AWS_SECRET_ACCESS_KEY ?? "absent");`,
      { env: sealedEnv },
    );
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toBe("absent");
  });

  it.skipIf(!hasSandboxExec)("PI_CODING_AGENT_DIR is forwarded when set in env", () => {
    const result = runInSandboxExec(
      `process.stdout.write(process.env.PI_CODING_AGENT_DIR ?? "absent");`,
      {
        env: {
          HOME: process.env.HOME!,
          PATH: "/usr/bin:/bin",
          PI_CODING_AGENT_DIR: "/private/tmp/fake-agent",
        },
      },
    );
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toBe("/private/tmp/fake-agent");
  });
});

// ── dir remap ─────────────────────────────────────────────────────────────────

describe("sandbox-exec: dir remap (PI_CODING_AGENT_DIR mirror)", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  const denylist = ["npm:@casualjim/pi-heimdall", "npm:@spences10/pi-confirm-destructive"];
  const allowedPkg = "npm:pi-agent-browser-native";

  it.skipIf(!hasSandboxExec)("PI_CODING_AGENT_DIR inside sandbox points to mirror", async () => {
    const agentDir = makeAgentDir(tmpDirs);
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
    const filteredPath = path.join(makeTmpDir(tmpDirs), "settings.json");
    await run(writeFilteredSettings(agentDir, {}, filteredPath));

    const mirrorDir = makeTmpDir(tmpDirs);
    createMirror(agentDir, mirrorDir, filteredPath);

    const result = runInSandboxExec(
      `process.stdout.write(process.env.PI_CODING_AGENT_DIR ?? "unset");`,
      {
        writePaths: [mirrorDir, agentDir],
        env: {
          HOME: process.env.HOME!,
          PATH: `${path.dirname(path.dirname(process.execPath))}/bin:/usr/bin:/bin`,
          PI_CODING_AGENT_DIR: mirrorDir,
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(mirrorDir);
  });

  it.skipIf(!hasSandboxExec)(
    "settings.json at PI_CODING_AGENT_DIR is the filtered version: denied packages absent",
    async () => {
      const agentDir = makeAgentDir(tmpDirs);
      fs.writeFileSync(
        path.join(agentDir, "settings.json"),
        JSON.stringify({ packages: [...denylist, allowedPkg] }),
      );
      const filteredPath = path.join(makeTmpDir(tmpDirs), "settings.json");
      await run(writeFilteredSettings(agentDir, { denyPackages: denylist }, filteredPath));

      const mirrorDir = makeTmpDir(tmpDirs);
      createMirror(agentDir, mirrorDir, filteredPath);

      const result = runInSandboxExec(`
        import { readFileSync } from "node:fs";
        const s = JSON.parse(readFileSync(process.env.PI_CODING_AGENT_DIR + "/settings.json", "utf8"));
        process.stdout.write(JSON.stringify(s.packages));
      `, {
        writePaths: [mirrorDir, agentDir],
        env: {
          HOME: process.env.HOME!,
          PATH: `${path.dirname(path.dirname(process.execPath))}/bin:/usr/bin:/bin`,
          PI_CODING_AGENT_DIR: mirrorDir,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      const packages: string[] = JSON.parse(result.stdout);
      expect(packages).not.toContain("npm:@casualjim/pi-heimdall");
      expect(packages).not.toContain("npm:@spences10/pi-confirm-destructive");
      expect(packages).toContain(allowedPkg);
    },
  );

  it.skipIf(!hasSandboxExec)(
    "real settings.json is untouched after sandbox writes to the mirror",
    async () => {
      const agentDir = makeAgentDir(tmpDirs);
      fs.writeFileSync(
        path.join(agentDir, "settings.json"),
        JSON.stringify({ packages: ["real-package"] }),
      );
      const filteredPath = path.join(makeTmpDir(tmpDirs), "settings.json");
      await run(writeFilteredSettings(agentDir, {}, filteredPath));

      const mirrorDir = makeTmpDir(tmpDirs);
      createMirror(agentDir, mirrorDir, filteredPath);

      runInSandboxExec(`
        import { writeFileSync } from "node:fs";
        writeFileSync(process.env.PI_CODING_AGENT_DIR + "/settings.json", JSON.stringify({ packages: ["written-inside"] }));
      `, {
        writePaths: [mirrorDir, agentDir],
        env: {
          HOME: process.env.HOME!,
          PATH: `${path.dirname(path.dirname(process.execPath))}/bin:/usr/bin:/bin`,
          PI_CODING_AGENT_DIR: mirrorDir,
        },
      });

      // Mirror's settings.json updated (hardlink — same inode as filteredPath)
      expect(JSON.parse(fs.readFileSync(filteredPath, "utf8")).packages).toEqual(["written-inside"]);
      // Real settings.json untouched
      expect(JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")).packages)
        .toEqual(["real-package"]);
    },
  );

  it.skipIf(!hasSandboxExec)(
    "writes to sessions/ follow the symlink and persist to the real agentDir",
    async () => {
      const agentDir = makeAgentDir(tmpDirs);
      fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
      const filteredPath = path.join(makeTmpDir(tmpDirs), "settings.json");
      await run(writeFilteredSettings(agentDir, {}, filteredPath));

      const mirrorDir = makeTmpDir(tmpDirs);
      createMirror(agentDir, mirrorDir, filteredPath);

      runInSandboxExec(`
        import { writeFileSync } from "node:fs";
        writeFileSync(process.env.PI_CODING_AGENT_DIR + "/sessions/probe.txt", "session-data");
      `, {
        writePaths: [mirrorDir, agentDir],
        env: {
          HOME: process.env.HOME!,
          PATH: `${path.dirname(path.dirname(process.execPath))}/bin:/usr/bin:/bin`,
          PI_CODING_AGENT_DIR: mirrorDir,
        },
      });

      expect(fs.existsSync(path.join(agentDir, "sessions", "probe.txt"))).toBe(true);
      expect(fs.readFileSync(path.join(agentDir, "sessions", "probe.txt"), "utf8"))
        .toBe("session-data");
    },
  );

  it.skipIf(!hasSandboxExec)(
    "auth.json is readable and writable (proper-lockfile can create auth.json.lock)",
    async () => {
      const agentDir = makeAgentDir(tmpDirs);
      fs.writeFileSync(
        path.join(agentDir, "auth.json"),
        JSON.stringify({ copilot: {}, anthropic: {} }),
      );
      fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
      const filteredPath = path.join(makeTmpDir(tmpDirs), "settings.json");
      await run(writeFilteredSettings(agentDir, {}, filteredPath));

      const mirrorDir = makeTmpDir(tmpDirs);
      createMirror(agentDir, mirrorDir, filteredPath);

      const result = runInSandboxExec(`
        import { readFileSync, writeFileSync } from "node:fs";
        const authFile = process.env.PI_CODING_AGENT_DIR + "/auth.json";
        const content = readFileSync(authFile, "utf8");
        const data = JSON.parse(content);
        writeFileSync(authFile, content);   // rw test: write same content back
        writeFileSync(authFile + ".lock", "locked");  // lockfile test
        process.stdout.write(JSON.stringify({ providers: Object.keys(data) }));
      `, {
        writePaths: [mirrorDir, agentDir],
        env: {
          HOME: process.env.HOME!,
          PATH: `${path.dirname(path.dirname(process.execPath))}/bin:/usr/bin:/bin`,
          PI_CODING_AGENT_DIR: mirrorDir,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      const { providers } = JSON.parse(result.stdout);
      expect(providers.length).toBeGreaterThan(0);
    },
  );
});

// ── network ───────────────────────────────────────────────────────────────────

describe("sandbox-exec: network", () => {
  it.skipIf(!hasSandboxExec)("resolves DNS inside sandbox-exec", async () => {
    // dns.lookup uses getaddrinfo → mDNSResponder via mach IPC → works.
    // dns.resolve4 uses c-ares → raw UDP to /etc/resolv.conf nameserver →
    // ECONNREFUSED on GitHub Actions (no DNS daemon on 127.0.0.1:53 on macOS).
    const result = runInSandboxExec(`
      import { lookup } from "node:dns/promises";
      const { address } = await lookup("github.com");
      process.stdout.write(JSON.stringify({ address }));
    `);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    const { address } = JSON.parse(result.stdout);
    expect(address.length).toBeGreaterThan(0);
  });

  it.skipIf(!hasSandboxExec)("reaches api.anthropic.com over HTTPS", async () => {
    const result = runInSandboxExec(`
      import { request } from "node:https";
      await new Promise((resolve, reject) => {
        const req = request(
          { hostname: "api.anthropic.com", path: "/", method: "GET", timeout: 5000 },
          (res) => { res.resume(); resolve(res.statusCode); },
        );
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        req.end();
      });
      process.stdout.write("ok");
    `, { timeout: 15000 });
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  it.skipIf(!hasSandboxExec)("reaches api.githubcopilot.com over HTTPS", async () => {
    const result = runInSandboxExec(`
      import { request } from "node:https";
      await new Promise((resolve, reject) => {
        const req = request(
          { hostname: "api.githubcopilot.com", path: "/", method: "GET", timeout: 5000 },
          (res) => { res.resume(); resolve(res.statusCode); },
        );
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        req.end();
      });
      process.stdout.write("ok");
    `, { timeout: 15000 });
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  it.skipIf(!hasSandboxExec)("can connect to a Unix socket (pit-escape pattern)", async () => {
    const tmpDirs: string[] = [];
    const socketDir = makeTmpDir(tmpDirs);
    const socketPath = path.join(socketDir, "test.sock");
    const serverScript = path.join("/private/tmp", `pit-sock-server-${process.pid}.mjs`);

    // Server must run in a SEPARATE subprocess — runInSandboxExec uses spawnSync
    // which blocks the event loop, so a server in the same process can never
    // accept the connection from the sandboxed client.
    fs.writeFileSync(serverScript, `
      import { createServer } from "node:net";
      const server = createServer((c) => { c.pipe(c); });
      server.listen(${JSON.stringify(socketPath)}, () => {
        process.stdout.write("ready\\n");
      });
    `);

    const serverProc = spawn(process.execPath, [serverScript], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    // Wait for the server to signal it is bound and accepting
    await new Promise<void>((resolve) => { serverProc.stdout!.once("data", () => resolve()); });

    try {
      const result = runInSandboxExec(`
        import { createConnection } from "node:net";
        await new Promise((resolve, reject) => {
          const sock = createConnection(${JSON.stringify(socketPath)});
          sock.on("connect", () => { sock.end(); resolve(undefined); });
          sock.on("error", reject);
        });
        process.stdout.write("connected");
      `);
      expect(result.status, `stderr: ${result.stderr}`).toBe(0);
      expect(result.stdout).toBe("connected");
    } finally {
      serverProc.kill();
      fs.rmSync(serverScript, { force: true });
      for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

// ── process execution ─────────────────────────────────────────────────────────

describe("sandbox-exec: process execution", () => {
  it.skipIf(!hasSandboxExec)("can spawn git --version inside sandbox", () => {
    const result = runInSandboxExec(`
      import { spawnSync } from "node:child_process";
      const r = spawnSync("git", ["--version"], { encoding: "utf8" });
      process.stdout.write(r.stdout.trim().startsWith("git") ? "ok" : "fail");
    `);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  it.skipIf(!hasSandboxExec)("can spawn a child node process inside sandbox", () => {
    const result = runInSandboxExec(`
      import { spawnSync } from "node:child_process";
      const nodeBin = process.execPath;
      const r = spawnSync(nodeBin, ["-e", "process.stdout.write('child')"], { encoding: "utf8" });
      process.stdout.write(r.stdout);
    `);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toBe("child");
  });
});

// ── lifetime binding ──────────────────────────────────────────────────────────
//
// sandbox-exec does not have --die-with-parent. pit uses spawn + signal
// forwarding instead. SIGKILL of the parent orphans the child — accepted,
// same behaviour as @anthropic-ai/sandbox-runtime (see plans/mac-sandbox.md).

describe("sandbox-exec: lifetime binding", () => {
  it.skipIf(!hasSandboxExec)("SIGTERM sent to sandbox-exec is forwarded and terminates child", async () => {
    const profile = buildTestProfile();
    const scriptFile = path.join("/private/tmp", `pit-sigterm-${process.pid}.mjs`);
    // Script that signals it's running then waits
    fs.writeFileSync(scriptFile, `
      process.stdout.write("ready\\n");
      await new Promise(() => {}); // wait forever
    `);

    try {
      const child = spawn(
        "/usr/bin/sandbox-exec",
        ["-p", profile, "--", process.execPath, scriptFile],
        { stdio: ["ignore", "pipe", "pipe"] },
      );

      // Wait for the ready signal
      await new Promise<void>((resolve) => {
        child.stdout!.once("data", () => resolve());
      });

      child.kill("SIGTERM");

      // When killed by signal, exit code is null (signal code is set instead).
      // The test passes if the process terminates at all.
      await new Promise<void>((resolve) => { child.once("exit", () => resolve()); });
    } finally {
      fs.rmSync(scriptFile, { force: true });
    }
  });

  it.skipIf(!hasSandboxExec)("SIGINT sent to sandbox-exec terminates child", async () => {
    const profile = buildTestProfile();
    const scriptFile = path.join("/private/tmp", `pit-sigint-${process.pid}.mjs`);
    fs.writeFileSync(scriptFile, `
      process.stdout.write("ready\\n");
      await new Promise(() => {});
    `);

    try {
      const child = spawn(
        "/usr/bin/sandbox-exec",
        ["-p", profile, "--", process.execPath, scriptFile],
        { stdio: ["ignore", "pipe", "pipe"] },
      );

      await new Promise<void>((resolve) => {
        child.stdout!.once("data", () => resolve());
      });

      child.kill("SIGINT");

      // Same: exit code is null when killed by signal, that's correct behaviour.
      await new Promise<void>((resolve) => { child.once("exit", () => resolve()); });
    } finally {
      fs.rmSync(scriptFile, { force: true });
    }
  });
});

// ── pi SDK inside sandbox-exec ────────────────────────────────────────────────

const nodeDir = path.dirname(path.dirname(process.execPath));
const piSdkPath = path.join(
  nodeDir, "lib", "node_modules",
  "@earendil-works", "pi-coding-agent", "dist", "index.js",
);
const hasPiSdk = fs.existsSync(piSdkPath);

describe("sandbox-exec: pi SDK", () => {
  it.skipIf(!hasSandboxExec || !hasPiSdk)("AuthStorage is readable and writable inside sandbox", async () => {
    const tmpDirs: string[] = [];
    afterEach(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

    const fakeAgentDir = makeTmpDir(tmpDirs);
    fs.writeFileSync(path.join(fakeAgentDir, "auth.json"), JSON.stringify({ copilot: {}, anthropic: {} }));

    const result = runInSandboxExec(`
      import { AuthStorage } from "${piSdkPath}";
      const auth = AuthStorage.create();
      process.stdout.write(JSON.stringify({ ok: true }));
    `, {
      writePaths: [fakeAgentDir],
      env: {
        HOME: process.env.HOME!,
        PATH: `${path.dirname(path.dirname(process.execPath))}/bin:/usr/local/bin:/usr/bin:/bin`,
        PI_CODING_AGENT_DIR: fakeAgentDir,
      },
      timeout: 10000,
    });
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    const { ok } = JSON.parse(result.stdout);
    expect(ok).toBe(true);
  });

  it.skipIf(!hasSandboxExec || !hasPiSdk)("models are available via SDK inside sandbox", async () => {
    const tmpDirs: string[] = [];
    afterEach(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

    const fakeAgentDir = makeTmpDir(tmpDirs);
    fs.writeFileSync(path.join(fakeAgentDir, "auth.json"), JSON.stringify({}));

    const result = runInSandboxExec(`
      import { AuthStorage, ModelRegistry } from "${piSdkPath}";
      const auth = AuthStorage.create();
      const registry = ModelRegistry.create(auth);
      const available = await registry.getAvailable();
      process.stdout.write(JSON.stringify({ count: available.length }));
    `, {
      writePaths: [fakeAgentDir],
      env: {
        HOME: process.env.HOME!,
        PATH: `${path.dirname(path.dirname(process.execPath))}/bin:/usr/local/bin:/usr/bin:/bin`,
        PI_CODING_AGENT_DIR: fakeAgentDir,
      },
      timeout: 15000,
    });
    expect(result.status, `SDK crashed — stderr: ${result.stderr}`).toBe(0);
    const { count } = JSON.parse(result.stdout);
    // count is 0 on CI (no real auth tokens) — correct SDK behaviour.
    // This test verifies the SDK initialises without crashing or hanging.
    expect(count, "SDK returned unexpected result").toBeGreaterThanOrEqual(0);
  });
});

// ── mach service validation (Grill 8) ────────────────────────────────────────
//
// These tests verify that each mach service in NODE_MACH_SERVICES is either
// required (removing it causes failure) or safe to remove (no regression).
//
// Run on a Mac with: npx vitest run tests/sandbox-macos.test.ts --reporter verbose
//
// Methodology: build a profile WITHOUT the candidate service, run a script that
// exercises the relevant subsystem, confirm it either hangs (timeout = needed)
// or succeeds (timeout = safe to remove). The timeout is the hang detection.
//
// TODO: implement individual service removal tests once the full baseline is
// confirmed passing. Each test removes ONE entry from NODE_MACH_SERVICES and
// asserts the result. Track which services can be trimmed.

describe("sandbox-exec: mach service baseline (Grill 8)", () => {
  it.skipIf(!hasSandboxExec || !hasPiSdk)(
    "full baseline mach list: AuthStorage initialises without hanging",
    async () => {
      const tmpDirs: string[] = [];
      afterEach(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

      const agentDir = makeTmpDir(tmpDirs);
      fs.writeFileSync(path.join(agentDir, "auth.json"), "{}");

      // timeout: 5s — a missing mach entry hangs; this catches it
      const result = runInSandboxExec(`
        import { AuthStorage } from "${piSdkPath}";
        AuthStorage.create();
        process.stdout.write("ok");
      `, {
        writePaths: [agentDir],
        env: {
          HOME: process.env.HOME!,
          PATH: `${path.dirname(path.dirname(process.execPath))}/bin:/usr/local/bin:/usr/bin:/bin`,
          PI_CODING_AGENT_DIR: agentDir,
        },
        timeout: 5000,
      });
      expect(result.status, `hang or error — stderr: ${result.stderr}`).toBe(0);
      expect(result.stdout).toBe("ok");
    },
  );
});
