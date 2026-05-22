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
  "escape",
  "server.ts"
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
function send(socketPath: string, req: object): Promise<Record<string, string | number | null | undefined>> {
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

async function getParentBranch(socketPath: string): Promise<string> {
  const resp = await send(socketPath, { op: "get-state" });
  const parent = (resp as Record<string, unknown>).parentBranch as string | null;
  if (!parent) throw new Error("get-state returned no parentBranch");
  return parent;
}

describe("git log and diff ops for rename-branch context", () => {
  it("log returns empty output when branch has no commits ahead of parent", async () => {
    const base = makeDir();
    const agentDir = makeDir();
    const pitDir = makeDir();
    const hostSettingsPath = path.join(agentDir, "settings.json");
    const { worktreeDir } = setupWorktree(base);

    const { socketPath } = await spawnEscape({ agentDir, pitDir, hostSettingsPath, worktreePath: worktreeDir });
    const parentBranch = await getParentBranch(socketPath);
    const resp = await send(socketPath, { op: "git", args: ["log", `${parentBranch}..HEAD`, "--oneline"] });

    expect(resp.code).toBe(0);
    expect((resp.stdout as string | undefined)?.trim()).toBe("");
  });

  it("log returns commit messages after commits are made on the branch", async () => {
    const base = makeDir();
    const agentDir = makeDir();
    const pitDir = makeDir();
    const hostSettingsPath = path.join(agentDir, "settings.json");
    const { worktreeDir } = setupWorktree(base);

    const file = path.join(worktreeDir, "change.txt");
    fs.writeFileSync(file, "hello");
    execFileSync("git", ["-C", worktreeDir, "add", "change.txt"]);
    execFileSync("git", ["-C", worktreeDir, "commit", "-m", "add change file"],
      { env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "t@t" } });

    const { socketPath } = await spawnEscape({ agentDir, pitDir, hostSettingsPath, worktreePath: worktreeDir });
    const parentBranch = await getParentBranch(socketPath);
    const resp = await send(socketPath, { op: "git", args: ["log", `${parentBranch}..HEAD`, "--oneline"] });

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
    const parentBranch = await getParentBranch(socketPath);
    const resp = await send(socketPath, { op: "git", args: ["diff", "--stat", `${parentBranch}...HEAD`] });

    expect(resp.code).toBe(0);
    expect(resp.stdout).toContain("feature.ts");
  });
});

// ── git test helpers (shared by is-merged and subscribe describe blocks) ──────

/** Create a git repo with an initial commit on `branch` (default: master). */
function initGitRepo(dir: string, branch = "master"): void {
  execFileSync("git", ["init", "-b", branch], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@pit.test"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "pit test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "init\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
}

/** Add a file commit in `dir` (worktree or main repo). */
function addCommit(dir: string, filename = "work.txt"): void {
  fs.writeFileSync(path.join(dir, filename), String(Date.now()));
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", `add ${filename}`], { cwd: dir });
}

/** Create a linked worktree from the main repo's HEAD. */
function createWorktree(mainRepo: string, worktreeDir: string, branch: string): void {
  execFileSync("git", ["-C", mainRepo, "worktree", "add", "-b", branch, worktreeDir, "HEAD"]);
}

// ── subscribe helper ──────────────────────────────────────────────────────────

interface Subscription {
  /** Resolves with the next message, or rejects after timeoutMs. */
  waitForMessage(timeoutMs?: number): Promise<Record<string, unknown>>;
  close(): void;
}

/**
 * Open a persistent subscribe connection to pit-escape.
 * Messages arrive as newline-delimited JSON; waitForMessage() lets tests
 * read them one at a time without racing with the data event.
 */
function openSubscription(socketPath: string): Subscription {
  const sock = net.createConnection(socketPath);
  let buf = "";
  const queue: Array<Record<string, unknown>> = [];
  const waiters: Array<{
    resolve: (m: Record<string, unknown>) => void;
    reject: (e: Error) => void;
  }> = [];

  const dispatch = (msg: Record<string, unknown>) => {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(msg);
    else queue.push(msg);
  };

  sock.once("connect", () => sock.write(JSON.stringify({ op: "subscribe" }) + "\n"));
  sock.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try { dispatch(JSON.parse(line)); } catch { /* skip malformed */ }
    }
  });
  sock.once("end", () => {
    // Server closed the connection (error case) — reject any pending waiters
    for (const w of waiters) w.reject(new Error("subscribe: connection closed"));
    waiters.length = 0;
  });
  sock.once("error", (err: Error) => {
    for (const w of waiters) w.reject(err);
    waiters.length = 0;
  });

  return {
    waitForMessage: (timeoutMs = 3000) =>
      new Promise((resolve, reject) => {
        const queued = queue.shift();
        if (queued) { resolve(queued); return; }
        const entry = { resolve, reject };
        waiters.push(entry);
        setTimeout(() => {
          const idx = waiters.indexOf(entry);
          if (idx !== -1) {
            waiters.splice(idx, 1);
            reject(new Error("subscribe: timed out waiting for message"));
          }
        }, timeoutMs);
      }),
    close: () => sock.destroy(),
  };
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

// ── is-merged op ──────────────────────────────────────────────────────────────
describe("pit-escape is-merged op", () => {
  it("returns merged:false for an unmerged branch with unique commits", async () => {
    const mainRepo = makeDir();
    const worktreeDir = makeDir();
    const agentDir = makeDir();
    const pitDir = makeDir();
    const hostSettingsPath = path.join(agentDir, "settings.json");

    initGitRepo(mainRepo);
    createWorktree(mainRepo, worktreeDir, "pi/test");
    addCommit(worktreeDir); // diverges from master

    const { socketPath } = await spawnEscape({ agentDir, pitDir, hostSettingsPath, worktreePath: worktreeDir });
    const resp = await send(socketPath, { op: "is-merged" });

    expect(resp.merged).toBe(false);
    expect(resp.branch).toBe("pi/test");
    expect(resp.parentBranch).toBe("master");
    expect(resp.aheadCount).toBe(1);
    expect(resp.behindCount).toBe(0);
  });

  it("returns merged:true after the branch is fast-forward merged into master", async () => {
    const mainRepo = makeDir();
    const worktreeDir = makeDir();
    const agentDir = makeDir();
    const pitDir = makeDir();
    const hostSettingsPath = path.join(agentDir, "settings.json");

    initGitRepo(mainRepo);
    createWorktree(mainRepo, worktreeDir, "pi/test");
    addCommit(worktreeDir);

    // Fast-forward master to include the worktree branch's commit
    execFileSync("git", ["-C", mainRepo, "merge", "--ff-only", "pi/test"]);

    const { socketPath } = await spawnEscape({ agentDir, pitDir, hostSettingsPath, worktreePath: worktreeDir });
    const resp = await send(socketPath, { op: "is-merged" });

    expect(resp.merged).toBe(true);
    expect(resp.branch).toBe("pi/test");
    expect(resp.parentBranch).toBe("master");
    expect(resp.aheadCount).toBe(0);
    expect(resp.behindCount).toBe(0);
  });

  it("returns merged:true when branch has no unique commits (newly forked, is-ancestor of master)", async () => {
    const mainRepo = makeDir();
    const worktreeDir = makeDir();
    const agentDir = makeDir();
    const pitDir = makeDir();
    const hostSettingsPath = path.join(agentDir, "settings.json");

    initGitRepo(mainRepo);
    createWorktree(mainRepo, worktreeDir, "pi/test");
    // No extra commits — branch tip equals master tip; branch IS an ancestor of master

    const { socketPath } = await spawnEscape({ agentDir, pitDir, hostSettingsPath, worktreePath: worktreeDir });
    const resp = await send(socketPath, { op: "is-merged" });

    expect(resp.merged).toBe(true);
    expect(resp.parentBranch).toBe("master");
    expect(resp.aheadCount).toBe(0);
    expect(resp.behindCount).toBe(0);
  });

  it("detects 'main' as the parent branch when master does not exist", async () => {
    const mainRepo = makeDir();
    const worktreeDir = makeDir();
    const agentDir = makeDir();
    const pitDir = makeDir();
    const hostSettingsPath = path.join(agentDir, "settings.json");

    initGitRepo(mainRepo, "main");
    createWorktree(mainRepo, worktreeDir, "pi/test");
    addCommit(worktreeDir);

    const { socketPath } = await spawnEscape({ agentDir, pitDir, hostSettingsPath, worktreePath: worktreeDir });
    const resp = await send(socketPath, { op: "is-merged" });

    expect(resp.merged).toBe(false);
    expect(resp.parentBranch).toBe("main");
    expect(resp.aheadCount).toBe(1);
    expect(resp.behindCount).toBe(0);
  });

  it("returns merged:false with null parentBranch when neither master nor main exists", async () => {
    const mainRepo = makeDir();
    const worktreeDir = makeDir();
    const agentDir = makeDir();
    const pitDir = makeDir();
    const hostSettingsPath = path.join(agentDir, "settings.json");

    initGitRepo(mainRepo, "trunk"); // neither master nor main
    createWorktree(mainRepo, worktreeDir, "pi/test");
    addCommit(worktreeDir);

    const { socketPath } = await spawnEscape({ agentDir, pitDir, hostSettingsPath, worktreePath: worktreeDir });
    const resp = await send(socketPath, { op: "is-merged" });

    expect(resp.merged).toBe(false);
    expect(resp.parentBranch).toBeNull();
    expect(resp.aheadCount).toBe(0);
    expect(resp.behindCount).toBe(0);
  });

  it("returns merged:false with null branch when worktreePath is not a linked worktree", async () => {
    const agentDir = makeDir(); // plain temp dir — no .git file
    const pitDir = makeDir();
    const hostSettingsPath = path.join(agentDir, "settings.json");

    const { socketPath } = await spawnEscape({ agentDir, pitDir, hostSettingsPath, worktreePath: agentDir });
    const resp = await send(socketPath, { op: "is-merged" });

    expect(resp.merged).toBe(false);
    expect(resp.branch).toBeNull();
    expect(resp.parentBranch).toBeNull();
    expect(resp.aheadCount).toBe(0);
    expect(resp.behindCount).toBe(0);
  });

  it("returns aheadCount matching the number of unique commits on the branch", async () => {
    const mainRepo = makeDir();
    const worktreeDir = makeDir();
    const agentDir = makeDir();
    const pitDir = makeDir();
    const hostSettingsPath = path.join(agentDir, "settings.json");

    initGitRepo(mainRepo);
    createWorktree(mainRepo, worktreeDir, "pi/test");
    addCommit(worktreeDir);
    addCommit(worktreeDir);

    const { socketPath } = await spawnEscape({ agentDir, pitDir, hostSettingsPath, worktreePath: worktreeDir });
    const resp = await send(socketPath, { op: "is-merged" });

    expect(resp.merged).toBe(false);
    expect(resp.aheadCount).toBe(2);
    expect(resp.behindCount).toBe(0);
  });

  it("returns correct aheadCount and behindCount when branch has diverged from master", async () => {
    const mainRepo = makeDir();
    const worktreeDir = makeDir();
    const agentDir = makeDir();
    const pitDir = makeDir();
    const hostSettingsPath = path.join(agentDir, "settings.json");

    initGitRepo(mainRepo);
    createWorktree(mainRepo, worktreeDir, "pi/test");
    // 2 commits on the worktree branch
    addCommit(worktreeDir);
    addCommit(worktreeDir);
    // 3 commits on master that the branch doesn't have
    addCommit(mainRepo);
    addCommit(mainRepo);
    addCommit(mainRepo);

    const { socketPath } = await spawnEscape({ agentDir, pitDir, hostSettingsPath, worktreePath: worktreeDir });
    const resp = await send(socketPath, { op: "is-merged" });

    expect(resp.merged).toBe(false);
    expect(resp.aheadCount).toBe(2);
    expect(resp.behindCount).toBe(3);
  });
});

// ── subscribe op ─────────────────────────────────────────────────────────────

describe("pit-escape subscribe op", () => {
  it("acknowledges subscription with { ok: true, watching: parentBranch }", async () => {
    const mainRepo = makeDir();
    const worktreeDir = makeDir();
    const agentDir = makeDir();
    const pitDir = makeDir();
    const hostSettingsPath = path.join(agentDir, "settings.json");

    initGitRepo(mainRepo);
    createWorktree(mainRepo, worktreeDir, "pi/test");

    const { socketPath } = await spawnEscape({ agentDir, pitDir, hostSettingsPath, worktreePath: worktreeDir });
    const sub = openSubscription(socketPath);
    const ack = await sub.waitForMessage();
    sub.close();

    expect(ack.ok).toBe(true);
    expect(ack.watching).toBe("master");
  });

  it("pushes { event: 'ref-change' } when parent branch is fast-forwarded", async () => {
    const mainRepo = makeDir();
    const worktreeDir = makeDir();
    const agentDir = makeDir();
    const pitDir = makeDir();
    const hostSettingsPath = path.join(agentDir, "settings.json");

    initGitRepo(mainRepo);
    createWorktree(mainRepo, worktreeDir, "pi/test");
    addCommit(worktreeDir);

    const { socketPath } = await spawnEscape({ agentDir, pitDir, hostSettingsPath, worktreePath: worktreeDir });
    const sub = openSubscription(socketPath);

    // Wait for ack before triggering — ensures watcher is set up first
    await sub.waitForMessage();

    // Fast-forward master to include the worktree commit
    execFileSync("git", ["-C", mainRepo, "merge", "--ff-only", "pi/test"]);

    const evt = await sub.waitForMessage(3000);
    sub.close();

    expect(evt.event).toBe("ref-change");
  });

  it("pushes { event: 'ref-change' } when a commit is added to the worktree branch", async () => {
    const mainRepo = makeDir();
    const worktreeDir = makeDir();
    const agentDir = makeDir();
    const pitDir = makeDir();
    const hostSettingsPath = path.join(agentDir, "settings.json");

    initGitRepo(mainRepo);
    createWorktree(mainRepo, worktreeDir, "pi/test");

    const { socketPath } = await spawnEscape({ agentDir, pitDir, hostSettingsPath, worktreePath: worktreeDir });
    const sub = openSubscription(socketPath);
    await sub.waitForMessage(); // ack

    // New commit on the worktree branch — no parent-branch change involved
    addCommit(worktreeDir);

    const evt = await sub.waitForMessage(3000);
    sub.close();

    expect(evt.event).toBe("ref-change");
  });

  it("sends error and closes when worktreePath is not a linked worktree", async () => {
    const agentDir = makeDir(); // plain dir, no .git file
    const pitDir = makeDir();
    const hostSettingsPath = path.join(agentDir, "settings.json");

    const { socketPath } = await spawnEscape({ agentDir, pitDir, hostSettingsPath, worktreePath: agentDir });
    const sub = openSubscription(socketPath);
    const resp = await sub.waitForMessage();
    sub.close();

    expect(resp.error).toBeDefined();
    expect(resp.ok).toBeUndefined();
  });

  it("sends error and closes when no master/main branch exists", async () => {
    const mainRepo = makeDir();
    const worktreeDir = makeDir();
    const agentDir = makeDir();
    const pitDir = makeDir();
    const hostSettingsPath = path.join(agentDir, "settings.json");

    initGitRepo(mainRepo, "trunk");
    createWorktree(mainRepo, worktreeDir, "pi/test");

    const { socketPath } = await spawnEscape({ agentDir, pitDir, hostSettingsPath, worktreePath: worktreeDir });
    const sub = openSubscription(socketPath);
    const resp = await sub.waitForMessage();
    sub.close();

    expect(resp.error).toBeDefined();
    expect(resp.ok).toBeUndefined();
  });

  it("pushes ref-change when merge-to-parent op is used (the /merge command path)", async () => {
    const mainRepo = makeDir();
    const worktreeDir = makeDir();
    const agentDir = makeDir();
    const pitDir = makeDir();
    const hostSettingsPath = path.join(agentDir, "settings.json");

    initGitRepo(mainRepo);
    createWorktree(mainRepo, worktreeDir, "pi/test");
    addCommit(worktreeDir);

    const { socketPath } = await spawnEscape({ agentDir, pitDir, hostSettingsPath, worktreePath: worktreeDir });
    const sub = openSubscription(socketPath);
    await sub.waitForMessage(); // ack

    // Trigger via the escape op exactly as /merge does
    const mergeResp = await send(socketPath, { op: "merge-to-parent", parentBranch: "master" });
    expect(mergeResp.code).toBe(0);

    // Subscription must receive the push without any polling
    const evt = await sub.waitForMessage(3000);
    sub.close();

    expect(evt.event).toBe("ref-change");
  });

  it("server continues to handle other requests after a subscription is closed", async () => {
    const mainRepo = makeDir();
    const worktreeDir = makeDir();
    const agentDir = makeDir();
    const pitDir = makeDir();
    const hostSettingsPath = path.join(agentDir, "settings.json");

    initGitRepo(mainRepo);
    createWorktree(mainRepo, worktreeDir, "pi/test");
    addCommit(worktreeDir);

    const { socketPath } = await spawnEscape({ agentDir, pitDir, hostSettingsPath, worktreePath: worktreeDir });

    // Open subscription, wait for ack, then close it
    const sub = openSubscription(socketPath);
    await sub.waitForMessage();
    sub.close();

    // A little breathing room for the server to process the close
    await new Promise((r) => setTimeout(r, 50));

    // Server should still handle normal request-response
    const resp = await send(socketPath, { op: "is-merged" });
    expect(resp.merged).toBe(false); // branch has unique commits
  });

  it("pushes ref-change when the branch is renamed via rename-branch op", async () => {
    const mainRepo = makeDir();
    const worktreeDir = makeDir();
    const agentDir = makeDir();
    const pitDir = makeDir();
    const hostSettingsPath = path.join(agentDir, "settings.json");

    initGitRepo(mainRepo);
    createWorktree(mainRepo, worktreeDir, "pi/original-name");

    const { socketPath } = await spawnEscape({ agentDir, pitDir, hostSettingsPath, worktreePath: worktreeDir });
    const sub = openSubscription(socketPath);
    await sub.waitForMessage(); // ack

    // Rename fires a ref-change: HEAD file changes + new ref created in refs/heads/pi/
    await send(socketPath, { op: "rename-branch", newBranch: "pi/new-name" });

    const evt = await sub.waitForMessage(3000);
    sub.close();

    expect(evt.event).toBe("ref-change");
  });

  it("pushes ref-change for commits made after a branch rename", async () => {
    // Regression: the branch watcher used to be set up once at subscribe time
    // with a filter on the original branch filename. After rename-branch,
    // commits on the new name were invisible to the watcher.
    const mainRepo = makeDir();
    const worktreeDir = makeDir();
    const agentDir = makeDir();
    const pitDir = makeDir();
    const hostSettingsPath = path.join(agentDir, "settings.json");

    initGitRepo(mainRepo);
    createWorktree(mainRepo, worktreeDir, "pi/original-name");

    const { socketPath } = await spawnEscape({ agentDir, pitDir, hostSettingsPath, worktreePath: worktreeDir });
    const sub = openSubscription(socketPath);
    await sub.waitForMessage(); // ack — watcher targeting "pi/original-name"

    // Rename the branch
    await send(socketPath, { op: "rename-branch", newBranch: "pi/new-name" });
    await sub.waitForMessage(3000); // consume the rename ref-change

    // Commit on the renamed branch — must still fire ref-change
    addCommit(worktreeDir);

    const evt = await sub.waitForMessage(3000);
    sub.close();

    expect(evt.event).toBe("ref-change");
  });
});
