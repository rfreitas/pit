/**
 * E2E tests for pit's non-interactive modes.
 *
 * Each test creates its own isolated git repo and agent dir in the system
 * temp dir so tests can run in parallel with no cross-test pollution.
 *
 * LLM cost: zero. Tests pass an empty auth.json via PI_CODING_AGENT_DIR.
 * Pi fails at the first LLM call, but pit's setup (worktree creation,
 * session pre-seeding, sandbox launch) all completes before that point.
 * Tests assert on those side effects and treat the LLM failure as the
 * expected terminal event.
 *
 * Sandbox: bwrap is part of what we're testing. Tests that require bwrap
 * are skipped when bwrap is not found (same guard as sandbox.test.ts).
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { findBwrap } from "../src/launcher/index.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

const PIT_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../pit.ts"
);

const hasBwrap = !!findBwrap();

/** Create a minimal git repo with one committed file. */
function makeGitRepo(tmpDirs: string[]): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pit-e2e-repo-")));
  tmpDirs.push(dir);
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "user.email", "test@pit.test"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "user.name", "pit test"], { stdio: "ignore" });
  fs.writeFileSync(path.join(dir, ".gitkeep"), "");
  execFileSync("git", ["-C", dir, "add", "."], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "commit", "-m", "init"], { stdio: "ignore" });
  return dir;
}

/** Create a plain (non-git) temp dir. */
function makePlainDir(tmpDirs: string[]): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pit-e2e-plain-")));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Create a temp agent dir with an empty auth.json.
 * Pi will find no API keys and fail at the first LLM call, but pit's
 * setup (worktree, session, sandbox) completes before that.
 */
function makeAgentDir(tmpDirs: string[]): string {
  // Use /tmp (not os.tmpdir()) to keep socket paths short: macOS limits
  // Unix domain socket paths to 104 chars, and os.tmpdir() on macOS is
  // /var/folders/wr/.../T (70+ chars), which leaves insufficient room for
  // the pit-<uuid>.sock suffix (46 chars).
  const dir = fs.mkdtempSync(path.join("/tmp", "pit-e2e-agent-"));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, "auth.json"), "{}");
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
  return dir;
}

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

/** Spawn pit as a subprocess, capture stdout/stderr. */
function runPit(
  args: string[],
  opts: { cwd: string; agentDir: string; extraEnv?: Record<string, string> }
): RunResult {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIT_SCRIPT, ...args],
    {
      cwd: opts.cwd,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: opts.agentDir,
        PI_SKIP_VERSION_CHECK: "1",        // Fast-fail proxy: pi-coding-agent sets undici's global dispatcher
        // to EnvHttpProxyAgent, which reads these env vars. Pointing at a
        // port that immediately refuses connections causes LLM HTTP calls
        // to fail in <1ms (ECONNREFUSED) instead of hanging for 30s.
        HTTPS_PROXY: "http://127.0.0.1:1",
        HTTP_PROXY: "http://127.0.0.1:1",        ...opts.extraEnv,
      },
      encoding: "utf8",
      timeout: 15000, // match vitest default testTimeout; CI first-run bwrap can be slower
    }
  );
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1,
  };
}

/** Parse all non-empty lines as JSON, returning the parsed objects. */
function parseJsonLines(text: string): unknown[] {
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * Find worktrees created by pit next to the given repo dir.
 * Pit names them <repo-basename>-wt-<id>.
 */
function findWorktrees(repoDir: string): string[] {
  const parent = path.dirname(repoDir);
  const prefix = path.basename(repoDir) + "-wt-";
  try {
    return fs.readdirSync(parent)
      .filter((d) => d.startsWith(prefix))
      .map((d) => path.join(parent, d));
  } catch {
    return [];
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("pit E2E — worktree lifecycle", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  // ── test 1 ─────────────────────────────────────────────────────────────────

  it("creates a worktree and branch when launched in a git repo (--mode json)", () => {
    const repo = makeGitRepo(tmpDirs);
    const agentDir = makeAgentDir(tmpDirs);

    const { stdout, stderr } = runPit(["--mode", "json", "hello"], { cwd: repo, agentDir });

    // Session header is the first JSON line emitted by pi --mode json.
    // It is emitted before any LLM call, so it's present even when auth fails.
    const lines = parseJsonLines(stdout);
    const header = lines.find((l: any) => l.type === "session") as any;
    expect(header, `stdout:\n${stdout}\nstderr:\n${stderr}`).toBeDefined();

    // The session cwd must be the worktree (not the repo root) because pit
    // pre-seeds the session file with cwd = worktree path.
    expect(header.cwd).not.toBe(repo);
    expect(header.cwd).toMatch(/-wt-[0-9a-f]{8}$/);

    // The worktree directory must exist on disk.
    const worktrees = findWorktrees(repo);
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0]).toBe(header.cwd);

    // The branch must exist in the repo.
    const branches = execFileSync("git", ["-C", repo, "branch"], { encoding: "utf8" });
    expect(branches).toMatch(/pi\/[0-9a-f]{8}/);
  });

  // ── test 2 ─────────────────────────────────────────────────────────────────

  it("-nt skips worktree creation, runs in repo dir (--mode json)", () => {
    const repo = makeGitRepo(tmpDirs);
    const agentDir = makeAgentDir(tmpDirs);

    const { stdout, stderr } = runPit(["-nt", "--mode", "json", "hello"], { cwd: repo, agentDir });

    const lines = parseJsonLines(stdout);
    const header = lines.find((l: any) => l.type === "session") as any;
    expect(header, `stdout:\n${stdout}\nstderr:\n${stderr}`).toBeDefined();

    // cwd must be the repo root, not a worktree
    expect(header.cwd).toBe(repo);

    // No worktree directory created
    expect(findWorktrees(repo)).toHaveLength(0);

    // No branch created
    const branches = execFileSync("git", ["-C", repo, "branch"], { encoding: "utf8" });
    expect(branches).not.toMatch(/pi\//);
  });

  // ── test 3 ─────────────────────────────────────────────────────────────────

  it("--no-session skips worktree creation (--mode json)", () => {
    // Fix 2: --no-session implies noTree because a session is the only way
    // to reference a worktree from pit. Without a session the branch is an orphan.
    const repo = makeGitRepo(tmpDirs);
    const agentDir = makeAgentDir(tmpDirs);

    runPit(["--no-session", "--mode", "json", "hello"], { cwd: repo, agentDir });

    // No worktree directory created
    expect(findWorktrees(repo)).toHaveLength(0);

    // No branch created
    const branches = execFileSync("git", ["-C", repo, "branch"], { encoding: "utf8" });
    expect(branches).not.toMatch(/pi\//);
  });

  // ── test 4 ─────────────────────────────────────────────────────────────────

  it("runs no-tree when launched outside a git repo (--mode json)", () => {
    const dir = makePlainDir(tmpDirs);
    const agentDir = makeAgentDir(tmpDirs);

    const { stdout, stderr } = runPit(["--mode", "json", "hello"], { cwd: dir, agentDir });

    // pi still starts and emits a session header
    const lines = parseJsonLines(stdout);
    const header = lines.find((l: any) => l.type === "session") as any;
    expect(header, `stdout:\n${stdout}\nstderr:\n${stderr}`).toBeDefined();

    // cwd is the plain dir, not a worktree
    expect(header.cwd).toBe(dir);

    // No worktrees anywhere
    expect(findWorktrees(dir)).toHaveLength(0);
  });

  // ── test 5 ─────────────────────────────────────────────────────────────────

  it("launching from inside an existing pit worktree reuses session, no nesting (--mode json)", () => {
    const repo = makeGitRepo(tmpDirs);
    const agentDir = makeAgentDir(tmpDirs);

    // First launch: creates a worktree
    runPit(["--mode", "json", "hello"], { cwd: repo, agentDir });
    const worktrees = findWorktrees(repo);
    expect(worktrees).toHaveLength(1);
    const worktree = worktrees[0];

    // Second launch: from inside the worktree
    const { stdout, stderr } = runPit(["--mode", "json", "hello"], { cwd: worktree, agentDir });

    // Session header should exist
    const lines = parseJsonLines(stdout);
    const header = lines.find((l: any) => l.type === "session") as any;
    expect(header, `stdout:\n${stdout}\nstderr:\n${stderr}`).toBeDefined();

    // Still only one worktree — no nesting
    expect(findWorktrees(repo)).toHaveLength(1);
  });
});

// ── stdout cleanliness ────────────────────────────────────────────────────────

describe("pit E2E — stdout cleanliness", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  // ── test 7 ─────────────────────────────────────────────────────────────────

  it("--mode json: every stdout line is valid JSON", () => {
    const repo = makeGitRepo(tmpDirs);
    const agentDir = makeAgentDir(tmpDirs);

    const { stdout } = runPit(["--mode", "json", "hello"], { cwd: repo, agentDir });

    const lines = stdout.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line), `not valid JSON: ${line}`).not.toThrow();
    }
  });

  // ── test 8 ─────────────────────────────────────────────────────────────────

  it("-p: no pit diagnostic lines on stdout (Fix 1)", () => {
    // pit has one console.log that was writing to stdout (line 537 of pit.ts),
    // triggered when launching from inside a linked worktree with no existing
    // session. Fix: changed to console.error. This test catches a regression.
    const repo = makeGitRepo(tmpDirs);
    const agentDir = makeAgentDir(tmpDirs);

    // First create a worktree session
    runPit(["--mode", "json", "hello"], { cwd: repo, agentDir });
    const worktrees = findWorktrees(repo);
    expect(worktrees).toHaveLength(1);

    // Launch -p from inside the worktree — triggers the formerly-stdout path
    const { stdout } = runPit(["-p", "hello"], { cwd: worktrees[0], agentDir });

    // No pit diagnostic lines must appear on stdout
    const pitLines = stdout.split("\n").filter((l) => l.startsWith("pit:"));
    expect(pitLines).toHaveLength(0);
  });

  // ── test 9 ─────────────────────────────────────────────────────────────────

  it("--no-session -p: no worktree created and stdout contains no pit diagnostics", () => {
    const repo = makeGitRepo(tmpDirs);
    const agentDir = makeAgentDir(tmpDirs);

    const { stdout } = runPit(["--no-session", "-p", "hello"], { cwd: repo, agentDir });

    // No worktrees
    expect(findWorktrees(repo)).toHaveLength(0);

    // No pit: lines on stdout
    const pitLines = stdout.split("\n").filter((l) => l.startsWith("pit:"));
    expect(pitLines).toHaveLength(0);
  });
});

// ── sandbox ───────────────────────────────────────────────────────────────────

describe("pit E2E — sandbox", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  // ── test 7 (sandbox) ───────────────────────────────────────────────────────

  it("sandboxed launch produces clean JSON stdout with no stderr errors", () => {
    const repo = makeGitRepo(tmpDirs);
    const agentDir = makeAgentDir(tmpDirs);

    const { stdout, stderr, status } = runPit(["--mode", "json", "hello"], { cwd: repo, agentDir });

    // Every stdout line must be valid JSON
    const lines = stdout.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line), `not valid JSON: ${line}\nstderr: ${stderr}`).not.toThrow();
    }

    // No error-level messages about the sandbox itself on stderr
    const sandboxErrors = stderr.split("\n").filter((l) => l.includes("bwrap") && l.includes("error"));
    expect(sandboxErrors).toHaveLength(0);
  });

  // ── test 8 (sandbox) ───────────────────────────────────────────────────────

  // This test only runs when NO sandbox tool is found on the current platform.
  // On Linux: skipped when bwrap is present.
  // On macOS: skipped when sandbox-exec is present (which is always true in practice).
  const hasSandboxTool = hasBwrap ||
    (process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec"));
  it.skipIf(hasSandboxTool)("no sandbox tool found: warns on stderr and still launches pi", () => {
    const repo = makeGitRepo(tmpDirs);
    const agentDir = makeAgentDir(tmpDirs);

    const { stdout, stderr } = runPit(["--mode", "json", "hello"], {
      cwd: repo,
      agentDir,
    });

    // pit warns on stderr that no sandbox tool was found
    expect(stderr).toContain("running without sandbox");

    // pi still starts — session header appears on stdout
    const lines = parseJsonLines(stdout);
    const header = lines.find((l: any) => l.type === "session");
    expect(header).toBeDefined();
  });
});

// ── session-already-open ──────────────────────────────────────────────────────

describe("pit E2E — session already open", () => {
  const tmpDirs: string[] = [];
  const servers: net.Server[] = [];

  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
    for (const s of servers) s.close();
    servers.length = 0;
  });

  it("exits with error when session socket is already alive", async () => {
    const repo = makeGitRepo(tmpDirs);
    const agentDir = makeAgentDir(tmpDirs);

    // Run pit once to find out the session ID it would use, then set up a
    // listening socket at that path to simulate "already open in another terminal".
    //
    // pit derives the session ID from worktreeCheck which calls genId() — we
    // can't predict it. Instead, we create the worktree+session first, then
    // find the socket path from the agent dir and replay it as "alive".
    //
    // Approach: run pit once (succeeds, creates worktree), find the socket
    // path pattern, start a real listener there, then run pit again from the
    // same worktree (which triggers the startPitEscape → probeSocket path).

    // First run: establishes the session and worktree
    runPit(["--mode", "json", "hello"], { cwd: repo, agentDir });
    const worktrees = findWorktrees(repo);
    expect(worktrees).toHaveLength(1);
    const worktree = worktrees[0];

    // Find session ID from the session file in agentDir
    const sessionsDir = path.join(agentDir, "sessions");
    const buckets = fs.readdirSync(sessionsDir);
    let sessionId: string | undefined;
    for (const bucket of buckets) {
      const files = fs.readdirSync(path.join(sessionsDir, bucket));
      if (files.length > 0) {
        // Session ID is the UUID in the session filename
        const file = files[0];
        const content = fs.readFileSync(path.join(sessionsDir, bucket, file), "utf8");
        const header = JSON.parse(content.split("\n")[0]);
        // pit-escape socket uses the session UUID from the session header
        sessionId = header.id;
        break;
      }
    }
    expect(sessionId).toBeDefined();

    // Start a real socket listener at the pit-escape path to simulate "alive"
    const socketPath = path.join(agentDir, `pit-${sessionId}.sock`);
    await new Promise<void>((resolve) => {
      const server = net.createServer();
      servers.push(server);
      server.listen(socketPath, resolve);
    });

    // Second run: from the worktree, pit should detect the live socket and exit
    const { stderr, status } = runPit(["--mode", "json", "hello"], { cwd: worktree, agentDir });

    expect(status).not.toBe(0);
    expect(stderr).toContain("already open in another terminal");
  });
});

// ── extension loading ────────────────────────────────────────────────────────────────

describe("pit E2E — extension loading", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("all pit extensions load without errors", () => {
    // Covers the real extension files pit registers via --extension.
    // Pi loads them at session start via Jiti (which uses CJS require under the hood).
    //
    // CRITICAL: Jiti crashes on sub-path imports (like "effect/Effect") because it 
    // resolves them to ESM files and fails to require() them. This test guarantees
    // our extensions stick to safe barrel imports ("effect") and load cleanly.
    //
    // The session header on stdout confirms pi started and attempted
    // to load extensions (without it the test is vacuous).
    const repo = makeGitRepo(tmpDirs);
    const agentDir = makeAgentDir(tmpDirs);

    const { stdout, stderr } = runPit(["--mode", "json", "hello"], { cwd: repo, agentDir });

    const lines = parseJsonLines(stdout);
    const header = lines.find((l: any) => l.type === "session");
    expect(header, `pi did not start — stdout:\n${stdout}\nstderr:\n${stderr}`).toBeDefined();

    const extensionErrors = stderr
      .split("\n")
      .filter((l) => l.includes("Failed to load extension"));

    expect(
      extensionErrors,
      `Extension loading errors:\n${extensionErrors.join("\n")}`
    ).toHaveLength(0);
  });
});

