#!/usr/bin/env -S node --experimental-strip-types
/**
 * pit — pi tree
 *
 * Usage:
 *   pit                  Create a worktree and launch pi
 *   pit --sandbox        Create a worktree and launch pi inside a bwrap sandbox
 *   pit list             List pit worktrees for current repo
 *   pit list --all       List all pit worktrees across all repos
 *   pit clean            Remove orphaned registry entries
 *   pit clean <id>       Remove a specific worktree by id
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execSync, execFileSync, spawnSync } from "node:child_process";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ── types ─────────────────────────────────────────────────────────────────────

interface WorktreeEntry {
  id: string;
  repo: string;
  worktree: string;
  branch: string;
  created: string;
}

interface Registry {
  worktrees: WorktreeEntry[];
}

// ── constants ─────────────────────────────────────────────────────────────────

const HOME = process.env.HOME!;
const AGENT_DIR = getAgentDir(); // respects PI_CODING_AGENT_DIR env override
const REGISTRY = path.join(path.dirname(AGENT_DIR), "pit", "registry.json");

// ── helpers ───────────────────────────────────────────────────────────────────

function genId(): string {
  return crypto.randomBytes(4).toString("hex");
}

function pathToBucketName(p: string): string {
  return "--" + p.replace(/[/\\]/g, "-").replace(/:/g, "-") + "--";
}

function sessionsDir(): string {
  return path.join(AGENT_DIR, "sessions");
}

function sessionFileFor(worktree: string): string | null {
  const bucket = path.join(sessionsDir(), pathToBucketName(worktree));
  if (!fs.existsSync(bucket)) return null;
  const files = fs
    .readdirSync(bucket)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => path.join(bucket, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] ?? null;
}

function sessionName(file: string | null): string {
  if (!file || !fs.existsSync(file)) return "(no session yet)";

  const lines = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim());

  // latest session_info name
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === "session_info" && entry.name) return entry.name;
    } catch {}
  }

  // first user message as preview
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.message?.role === "user") {
        const content = entry.message.content;
        if (Array.isArray(content)) {
          for (const c of content) {
            if (c.type === "text" && c.text)
              return (c.text as string).slice(0, 60).replace(/\n/g, " ");
          }
        }
      }
    } catch {}
  }

  return "(no session yet)";
}

// ── registry ──────────────────────────────────────────────────────────────────

function registryLoad(): Registry {
  fs.mkdirSync(path.dirname(REGISTRY), { recursive: true });
  if (!fs.existsSync(REGISTRY))
    fs.writeFileSync(REGISTRY, JSON.stringify({ worktrees: [] }, null, 2));
  return JSON.parse(fs.readFileSync(REGISTRY, "utf8")) as Registry;
}

function registrySave(reg: Registry): void {
  fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2));
}

function registryAdd(entry: WorktreeEntry): void {
  const reg = registryLoad();
  reg.worktrees.push(entry);
  registrySave(reg);
}

function registryRemove(id: string): void {
  const reg = registryLoad();
  reg.worktrees = reg.worktrees.filter((w) => w.id !== id);
  registrySave(reg);
}

// ── git ───────────────────────────────────────────────────────────────────────

function requireGitRepo(): void {
  try {
    execSync("git rev-parse --show-toplevel", { stdio: "ignore" });
  } catch {
    console.error("pit: not inside a git repository");
    process.exit(1);
  }
}

function repoRoot(): string {
  return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
}

// ── sandbox ───────────────────────────────────────────────────────────────────

function getExtensionMounts(): string[] {
  const settingsFile = path.join(AGENT_DIR, "settings.json");
  if (!fs.existsSync(settingsFile)) return [];

  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  const extensions: string[] = settings.extensions ?? [];
  const mounts = new Set<string>();

  for (const ext of extensions) {
    if (!fs.existsSync(ext)) continue;
    mounts.add(ext);
    // walk up looking for node_modules
    let parent = path.dirname(ext);
    while (true) {
      const nm = path.join(parent, "node_modules");
      if (fs.existsSync(nm)) {
        mounts.add(nm);
        break;
      }
      const up = path.dirname(parent);
      if (up === parent) break;
      parent = up;
    }
  }

  return [...mounts].sort();
}

function findBwrap(): string | null {
  for (const p of ["/usr/bin/bwrap", "/usr/local/bin/bwrap"]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function launchSandboxed(worktree: string): never {
  const bwrap = findBwrap();
  if (!bwrap) {
    console.error("pit: bwrap not found — falling back to unsandboxed launch");
    return launchUnsandboxed(worktree);
  }

  // process.execPath is the running node binary — no `which node` needed
  const nodeBin = process.execPath;
  const nodeDir = path.dirname(path.dirname(nodeBin));
  // pi script: resolve via `which pi` since import.meta.resolve finds the local
  // copy, not the global binary on PATH that is actually running
  const piScript = fs.realpathSync(
    execSync("which pi", { encoding: "utf8" }).trim()
  );
  // AGENT_DIR already respects PI_CODING_AGENT_DIR
  const piAgentDir = fs.realpathSync(AGENT_DIR);
  const pitDir = path.dirname(REGISTRY);
  fs.mkdirSync(pitDir, { recursive: true });

  const args: string[] = [
    "--tmpfs", "/",
    "--dev", "/dev",
    "--proc", "/proc",

    // system (read-only)
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/etc", "/etc",
    "--ro-bind-try", "/lib", "/lib",
    "--ro-bind-try", "/lib64", "/lib64",
    "--ro-bind-try", "/bin", "/bin",
    "--ro-bind-try", "/sbin", "/sbin",

    // node + pi runtime (read-only)
    "--ro-bind", nodeDir, nodeDir,

    // pi config: mount real target at AGENT_DIR, sessions rw on top
    "--dir", path.dirname(AGENT_DIR),
    "--ro-bind", piAgentDir, AGENT_DIR,
    "--bind", path.join(piAgentDir, "sessions"), path.join(AGENT_DIR, "sessions"),

    // pit registry (read-write)
    "--bind", pitDir, pitDir,

    // worktree (read-write — the whole point)
    "--bind", worktree, worktree,
  ];

  // extension dirs and their node_modules (read-only)
  for (const mount of getExtensionMounts()) {
    args.push("--ro-bind", mount, mount);
  }

  args.push(
    "--unshare-user",
    "--unshare-pid",
    "--die-with-parent",

    "--setenv", "HOME", HOME,
    "--setenv", "PATH", `${nodeDir}/bin:/usr/local/bin:/usr/bin:/bin`,
    "--setenv", "PI_CODING_AGENT", "true",

    "--chdir", worktree,
    "--",
    nodeBin, piScript
  );

  const result = spawnSync(bwrap, args, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

function launchUnsandboxed(worktree: string): never {
  process.chdir(worktree);
  const result = spawnSync("pi", [], { stdio: "inherit", shell: false });
  process.exit(result.status ?? 1);
}

// ── commands ──────────────────────────────────────────────────────────────────

function cmdNew(flags: string[]): void {
  let sandbox = false;
  for (const flag of flags) {
    if (flag === "--sandbox") sandbox = true;
    else {
      console.error(`pit: unknown option '${flag}'`);
      process.exit(1);
    }
  }

  requireGitRepo();

  const id = genId();
  const root = repoRoot();
  const branch = `pi/${id}`;
  const worktree = path.join(
    path.dirname(root),
    `${path.basename(root)}-wt-${id}`
  );
  const created = new Date().toISOString();

  console.log("pit: creating worktree");
  console.log(`  id:       ${id}`);
  console.log(`  branch:   ${branch}`);
  console.log(`  worktree: ${worktree}`);
  if (sandbox) console.log("  sandbox:  bwrap");

  execFileSync("git", ["worktree", "add", "-b", branch, worktree, "HEAD"], {
    stdio: "inherit",
  });
  registryAdd({ id, repo: root, worktree, branch, created });

  console.log("pit: launching pi");
  if (sandbox) launchSandboxed(worktree);
  else launchUnsandboxed(worktree);
}

function cmdList(args: string[]): void {
  const showAll = args.includes("--all");
  let currentRepo: string | null = null;
  if (!showAll) {
    try {
      currentRepo = repoRoot();
    } catch {}
  }

  const reg = registryLoad();
  const entries = showAll
    ? reg.worktrees
    : reg.worktrees.filter((w) => !currentRepo || w.repo === currentRepo);

  if (entries.length === 0) {
    console.log("no pit worktrees");
    return;
  }

  if (showAll) {
    console.log(
      "ID          REPO                  SESSION NAME                              STATUS"
    );
    console.log(
      "----------  --------------------  ----------------------------------------  --------"
    );
  } else {
    console.log(
      "ID          BRANCH          SESSION NAME                              STATUS"
    );
    console.log(
      "----------  --------------  ----------------------------------------  --------"
    );
  }

  for (const entry of entries) {
    const status = fs.existsSync(entry.worktree) ? "active" : "orphaned";
    const name = sessionName(sessionFileFor(entry.worktree)).slice(0, 40);

    if (showAll) {
      const repo = path.basename(entry.repo).slice(0, 20);
      console.log(
        `${entry.id.padEnd(10)}  ${repo.padEnd(20)}  ${name.padEnd(40)}  ${status}`
      );
    } else {
      console.log(
        `${entry.id.padEnd(10)}  ${entry.branch.padEnd(14)}  ${name.padEnd(40)}  ${status}`
      );
    }
  }
}

function cmdClean(args: string[]): void {
  const id = args[0];
  const reg = registryLoad();

  if (id) {
    const entry = reg.worktrees.find((w) => w.id === id);
    if (!entry) {
      console.error(`pit clean: no worktree with id '${id}'`);
      process.exit(1);
    }

    if (fs.existsSync(entry.worktree)) {
      console.log(`pit: removing worktree: ${entry.worktree}`);
      execFileSync(
        "git",
        ["-C", entry.repo, "worktree", "remove", "--force", entry.worktree],
        { stdio: "inherit" }
      );
    }

    const shortBranch = entry.branch.replace(/^refs\/heads\//, "");
    try {
      execFileSync(
        "git",
        ["-C", entry.repo, "show-ref", "--verify", "--quiet", `refs/heads/${shortBranch}`],
        { stdio: "ignore" }
      );
      console.log(`pit: deleting branch: ${shortBranch}`);
      execFileSync("git", ["-C", entry.repo, "branch", "-D", shortBranch], {
        stdio: "inherit",
      });
    } catch {}

    registryRemove(id);
    console.log("pit: done");
  } else {
    // remove orphaned entries
    let removed = 0;
    // reload each time since registryRemove re-reads
    for (const entry of registryLoad().worktrees) {
      if (!fs.existsSync(entry.worktree)) {
        console.log(
          `pit: removing orphaned entry: ${entry.id} (${entry.worktree})`
        );
        registryRemove(entry.id);
        removed++;
      }
    }
    if (removed === 0) console.log("pit: no orphaned entries");
    else console.log(`pit: removed ${removed} orphaned entries`);
  }
}

function cmdHelp(): void {
  console.log(`pit — pi tree

Usage:
  pit                  Create a worktree and launch pi
  pit --sandbox        Create a worktree and launch pi inside a bwrap sandbox
  pit list             List pit worktrees for current repo
  pit list --all       List all pit worktrees across all repos
  pit clean            Remove orphaned registry entries
  pit clean <id>       Remove a specific worktree by id`);
}

// ── dispatch ──────────────────────────────────────────────────────────────────

const [, , cmd = "", ...rest] = process.argv;

switch (cmd) {
  case "list":
    cmdList(rest);
    break;
  case "clean":
    cmdClean(rest);
    break;
  case "-h":
  case "--help":
    cmdHelp();
    break;
  default:
    // cmd is '' (no args) or a flag like '--sandbox'
    cmdNew(cmd ? [cmd, ...rest] : rest);
}
