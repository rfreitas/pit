/**
 * Shared test helpers for pit/src unit tests.
 *
 * Provides setup utilities so tests stay focused on assertions and
 * every it() keeps its full semantic name.
 */

import { afterEach } from "vitest";
import { Effect } from "effect";
import { NodeContext } from "@effect/platform-node";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// ── constants ─────────────────────────────────────────────────────────────────

export const TEST_SANDBOX = path.join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "test-sandbox",
);

// ── Effect runner ─────────────────────────────────────────────────────────────

export const run = <A>(eff: Effect.Effect<A, unknown, NodeContext.NodeContext>): Promise<A> =>
  Effect.runPromise(eff.pipe(Effect.provide(NodeContext.layer)));

// ── tmp dir lifecycle ─────────────────────────────────────────────────────────

/**
 * Register an afterEach cleanup and return helpers to create temp directories.
 * Call once at the top of a test file; every dir created via the returned
 * helpers is automatically deleted after each test.
 */
export const useTmpDirs = () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  const makeTmp = (prefix: string): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(d);
    return d;
  };

  const makeSandbox = (prefix: string): string => {
    fs.mkdirSync(TEST_SANDBOX, { recursive: true });
    const d = fs.mkdtempSync(path.join(TEST_SANDBOX, prefix));
    dirs.push(d);
    return d;
  };

  return { makeTmp, makeSandbox };
};

// ── git repo factory ──────────────────────────────────────────────────────────

/**
 * Create a minimal git repo with one empty commit. Pass the `makeTmp`
 * function from `useTmpDirs` so the repo is registered for cleanup.
 */
export const makeGitRepo = (makeTmp: (prefix: string) => string): string => {
  const repo = makeTmp("pit-git-repo-");
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.email", "test@pit.test"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.name", "pit test"], { stdio: "ignore" });
  fs.writeFileSync(path.join(repo, ".gitkeep"), "");
  execFileSync("git", ["-C", repo, "add", "."], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "commit", "-m", "init"], { stdio: "ignore" });
  return repo;
};
