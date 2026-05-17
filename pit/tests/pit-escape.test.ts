/**
 * Integration tests for the pit-escape refresh-settings protocol.
 *
 * Spawns the actual pit-escape process and communicates with it over a Unix
 * socket — the same path the sandboxed pi session uses at runtime. Tests the
 * refresh-settings op in isolation from the rest of the system.
 *
 * What's under test:
 *   - The op reads current host settings.json and pit config.json
 *   - Denied packages are removed from the output file
 *   - Allowed packages are preserved
 *   - Re-calling the op picks up changes to settings.json (the /reload case:
 *     user installs a package globally, then reloads inside a pit session)
 *   - Missing pit config.json is treated as no denylist (passthrough)
 *   - Missing settings.json produces an empty output (no crash)
 */

import { fileURLToPath } from "node:url";
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";

// ── helpers ───────────────────────────────────────────────────────────────────

const TEST_SANDBOX = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "test-sandbox"
);
const PIT_ESCAPE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "pit-escape.ts"
);

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
  const d = fs.mkdtempSync(path.join(TEST_SANDBOX, "escape-test-"));
  tmpDirs.push(d);
  return d;
}

/**
 * Spawn pit-escape and wait for it to signal readiness.
 * Uses a dummy worktree path — the refresh-settings op doesn't need a real worktree.
 */
async function spawnEscape(opts: {
  agentDir: string;
  pitDir: string;
  hostSettingsPath: string;
  worktreePath?: string;
}): Promise<{ socketPath: string }> {
  const socketPath = path.join(opts.agentDir, "test.sock");
  const worktreePath = opts.worktreePath ?? opts.agentDir;
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--no-warnings",
      PIT_ESCAPE,
      socketPath,
      worktreePath,
      opts.agentDir,
      opts.pitDir,
      opts.hostSettingsPath,
    ],
    { stdio: ["ignore", "pipe", "inherit"] }
  );
  children.push(child);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("pit-escape timed out")), 5000);
    child.stdout!.once("data", () => { clearTimeout(timer); resolve(); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) reject(new Error(`pit-escape exited with code ${code}`));
    });
  });

  return { socketPath };
}

/** Send one request to pit-escape and return the parsed response. */
function send(socketPath: string, req: object): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const sock = net.createConnection(socketPath);
    let buf = "";
    sock.once("connect", () => { sock.write(JSON.stringify(req) + "\n"); });
    sock.on("data", (chunk: Buffer) => { buf += chunk.toString("utf8"); });
    sock.once("end", () => {
      try { resolve(JSON.parse(buf.trim())); }
      catch { resolve({ error: "parse error" }); }
    });
    sock.once("error", (err: Error) => { resolve({ error: err.message }); });
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("pit-escape refresh-settings op", () => {
  const denylist = [
    "npm:@casualjim/pi-heimdall",
    "npm:@spences10/pi-confirm-destructive",
    "npm:@jerryan/pi-sanity",
  ];

  const allPackages = [...denylist, "npm:pi-agent-browser-native", "npm:agent-browser"];

  it("responds { ok: true } on success", async () => {
    const agentDir = makeDir();
    const pitDir = makeDir();
    const outDir = makeDir();
    const hostSettingsPath = path.join(outDir, "settings.json");

    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ packages: allPackages })
    );
    fs.writeFileSync(
      path.join(pitDir, "config.json"),
      JSON.stringify({ denyPackages: denylist })
    );

    const { socketPath } = await spawnEscape({ agentDir, pitDir, hostSettingsPath });
    const resp = await send(socketPath, { op: "refresh-settings" });
    expect(resp.ok).toBe(true);
    expect(resp.error).toBeUndefined();
  });

  it("writes the filtered settings file to hostSettingsPath", async () => {
    const agentDir = makeDir();
    const pitDir = makeDir();
    const outDir = makeDir();
    const hostSettingsPath = path.join(outDir, "settings.json");

    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ packages: allPackages })
    );
    fs.writeFileSync(
      path.join(pitDir, "config.json"),
      JSON.stringify({ denyPackages: denylist })
    );

    const { socketPath } = await spawnEscape({ agentDir, pitDir, hostSettingsPath });
    await send(socketPath, { op: "refresh-settings" });

    expect(fs.existsSync(hostSettingsPath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(hostSettingsPath, "utf8"));
    for (const p of denylist) {
      expect(written.packages).not.toContain(p);
    }
    expect(written.packages).toContain("npm:pi-agent-browser-native");
    expect(written.packages).toContain("npm:agent-browser");
  });

  it("without a pit config, passes all packages through unchanged", async () => {
    const agentDir = makeDir();
    const pitDir = makeDir(); // no config.json
    const outDir = makeDir();
    const hostSettingsPath = path.join(outDir, "settings.json");

    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ packages: allPackages })
    );

    const { socketPath } = await spawnEscape({ agentDir, pitDir, hostSettingsPath });
    await send(socketPath, { op: "refresh-settings" });

    const written = JSON.parse(fs.readFileSync(hostSettingsPath, "utf8"));
    expect(written.packages).toEqual(allPackages);
  });

  it("picks up changes to settings.json on a second call (the /reload case)", async () => {
    // Simulate: user runs `pi install npm:new-package` outside the session.
    // A subsequent /reload in the pit session should pick it up (minus denylist).
    const agentDir = makeDir();
    const pitDir = makeDir();
    const outDir = makeDir();
    const hostSettingsPath = path.join(outDir, "settings.json");

    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ packages: allPackages })
    );
    fs.writeFileSync(
      path.join(pitDir, "config.json"),
      JSON.stringify({ denyPackages: denylist })
    );

    const { socketPath } = await spawnEscape({ agentDir, pitDir, hostSettingsPath });

    // First call — baseline
    await send(socketPath, { op: "refresh-settings" });
    const before = JSON.parse(fs.readFileSync(hostSettingsPath, "utf8"));
    expect(before.packages).not.toContain("npm:brand-new-package");

    // Host settings change (global install outside the session)
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ packages: [...allPackages, "npm:brand-new-package"] })
    );

    // Second call — should pick up the new package (and still apply denylist)
    await send(socketPath, { op: "refresh-settings" });
    const after = JSON.parse(fs.readFileSync(hostSettingsPath, "utf8"));
    expect(after.packages).toContain("npm:brand-new-package");
    for (const p of denylist) {
      expect(after.packages).not.toContain(p);
    }
  });

  it("absent settings.json produces an empty-packages output without crashing", async () => {
    const agentDir = makeDir(); // no settings.json
    const pitDir = makeDir();
    const outDir = makeDir();
    const hostSettingsPath = path.join(outDir, "settings.json");

    fs.writeFileSync(
      path.join(pitDir, "config.json"),
      JSON.stringify({ denyPackages: denylist })
    );

    const { socketPath } = await spawnEscape({ agentDir, pitDir, hostSettingsPath });
    const resp = await send(socketPath, { op: "refresh-settings" });
    expect(resp.ok).toBe(true);
    const written = JSON.parse(fs.readFileSync(hostSettingsPath, "utf8"));
    expect(written.packages ?? []).toEqual([]);
  });
});

// ── rename-branch op ──────────────────────────────────────────────────────────

/**
 * Create a minimal git repo with one empty commit, then add a linked worktree
 * on a branch named `pi/test-branch`. Returns the paths needed to spawn
 * pit-escape against that worktree.
 */
function setupWorktree(baseDir: string): { worktreeDir: string; branchName: string } {
  const repoDir = path.join(baseDir, "repo");
  const worktreeDir = path.join(baseDir, "worktree");
  const branchName = "pi/test-branch";

  fs.mkdirSync(repoDir, { recursive: true });
  const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
  git(["init"]);
  git(["config", "user.email", "test@pit.local"]);
  git(["config", "user.name", "pit test"]);
  git(["commit", "--allow-empty", "-m", "initial"]);
  git(["worktree", "add", "-b", branchName, worktreeDir]);

  return { worktreeDir, branchName };
}

function readCurrentBranch(worktreeDir: string): string | null {
  try {
    const gitFile = fs.readFileSync(path.join(worktreeDir, ".git"), "utf8")
      .trim().replace(/^gitdir:\s*/, "");
    const head = fs.readFileSync(path.join(gitFile, "HEAD"), "utf8").trim();
    const m = head.match(/^ref: refs\/heads\/(.+)$/);
    return m ? m[1] : null;
  } catch { return null; }
}

describe("pit-escape rename-branch op", () => {
  it("renames the current branch and updates the worktree HEAD", async () => {
    const base = makeDir();
    const agentDir = makeDir();
    const pitDir = makeDir();
    const hostSettingsPath = path.join(agentDir, "settings.json");
    const { worktreeDir, branchName } = setupWorktree(base);

    const { socketPath } = await spawnEscape({ agentDir, pitDir, hostSettingsPath, worktreePath: worktreeDir });
    const resp = await send(socketPath, { op: "rename-branch", newBranch: "pi/new-name" });

    expect(resp.code).toBe(0);
    expect(resp.error).toBeUndefined();
    expect(readCurrentBranch(worktreeDir)).toBe("pi/new-name");
    expect(branchName).toBe("pi/test-branch"); // confirm it changed
  });

  it("returns an error when newBranch is missing", async () => {
    const agentDir = makeDir();
    const pitDir = makeDir();
    const hostSettingsPath = path.join(agentDir, "settings.json");

    const { socketPath } = await spawnEscape({ agentDir, pitDir, hostSettingsPath });
    const resp = await send(socketPath, { op: "rename-branch" });

    expect(resp.error).toMatch(/newBranch/);
  });

  it("returns a git error when the target branch name already exists", async () => {
    const base = makeDir();
    const agentDir = makeDir();
    const pitDir = makeDir();
    const hostSettingsPath = path.join(agentDir, "settings.json");
    const { worktreeDir } = setupWorktree(base);

    // create a second branch in the repo so the name is taken
    const repoDir = path.join(base, "repo");
    execFileSync("git", ["-C", repoDir, "branch", "pi/already-exists"]);

    const { socketPath } = await spawnEscape({ agentDir, pitDir, hostSettingsPath, worktreePath: worktreeDir });
    const resp = await send(socketPath, { op: "rename-branch", newBranch: "pi/already-exists" });

    expect(resp.code).not.toBe(0);
  });
});

// ── git context ops (log + diff used by rename-branch) ──────────────────────

describe("git log and diff ops for rename-branch context", () => {
  it("log returns empty output when branch has no commits ahead of parent", async () => {
    const base = makeDir();
    const agentDir = makeDir();
    const pitDir = makeDir();
    const hostSettingsPath = path.join(agentDir, "settings.json");
    const { worktreeDir } = setupWorktree(base);

    const { socketPath } = await spawnEscape({ agentDir, pitDir, hostSettingsPath, worktreePath: worktreeDir });
    const resp = await send(socketPath, { op: "git", args: ["log", "master..HEAD", "--oneline"] });

    expect(resp.code).toBe(0);
    expect(resp.stdout?.trim()).toBe("");
  });

  it("log returns commit messages after commits are made on the branch", async () => {
    const base = makeDir();
    const agentDir = makeDir();
    const pitDir = makeDir();
    const hostSettingsPath = path.join(agentDir, "settings.json");
    const { worktreeDir } = setupWorktree(base);

    // Make a commit on the worktree branch
    const file = path.join(worktreeDir, "change.txt");
    fs.writeFileSync(file, "hello");
    execFileSync("git", ["-C", worktreeDir, "add", "change.txt"]);
    execFileSync("git", ["-C", worktreeDir, "commit", "-m", "add change file"],
      { env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "t@t" } });

    const { socketPath } = await spawnEscape({ agentDir, pitDir, hostSettingsPath, worktreePath: worktreeDir });
    const resp = await send(socketPath, { op: "git", args: ["log", "master..HEAD", "--oneline"] });

    expect(resp.code).toBe(0);
    expect(resp.stdout).toContain("add change file");
  });

  it("diff --stat returns file summary after commits are made on the branch", async () => {
    const base = makeDir();
    const agentDir = makeDir();
    const pitDir = makeDir();
    const hostSettingsPath = path.join(agentDir, "settings.json");
    const { worktreeDir } = setupWorktree(base);

    const file = path.join(worktreeDir, "feature.ts");
    fs.writeFileSync(file, "export const x = 1;");
    execFileSync("git", ["-C", worktreeDir, "add", "feature.ts"]);
    execFileSync("git", ["-C", worktreeDir, "commit", "-m", "add feature"],
      { env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "t@t" } });

    const { socketPath } = await spawnEscape({ agentDir, pitDir, hostSettingsPath, worktreePath: worktreeDir });
    const resp = await send(socketPath, { op: "git", args: ["diff", "--stat", "master...HEAD"] });

    expect(resp.code).toBe(0);
    expect(resp.stdout).toContain("feature.ts");
  });
});
