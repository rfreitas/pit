/**
 * Git filesystem utilities — all IO operations are Effect-based.
 *
 * FileSystem service: reading .git files, stat checks.
 * CommandExecutor service: spawning git subprocesses.
 *
 * Error policy:
 *   - "not applicable" states (not a linked worktree, not in a repo, branch
 *     absent) absorb errors and return null/false — error channel is never.
 *   - "should succeed but failed" states (list worktrees, check rw mounts,
 *     branch existence subprocess failure) propagate PlatformError so callers
 *     can decide whether to abort or degrade gracefully.
 */

import { join, resolve } from "node:path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { make as makeCommand, string as commandString, exitCode as commandExitCode } from "@effect/platform/Command";
import { FileSystem } from "@effect/platform/FileSystem";
import { CommandExecutor } from "@effect/platform/CommandExecutor";
import type { PlatformError } from "@effect/platform/Error";

// ── linked worktree detection ─────────────────────────────────────────────────

/**
 * Return true if cwd is a linked git worktree.
 * Returns false for main checkouts, non-git dirs, or any read error.
 */
export const isLinkedWorktree = (
  cwd: string,
): Effect.Effect<boolean, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const gitPath = join(cwd, ".git");
    const exists = yield* fs.exists(gitPath).pipe(Effect.orElse(() => Effect.succeed(false)));
    if (!exists) return false;
    const info = yield* fs.stat(gitPath).pipe(Effect.orElse(() => Effect.succeed(null)));
    if (!info || info.type === "Directory") return false;
    const content = yield* fs.readFileString(gitPath).pipe(Effect.orElse(() => Effect.succeed("")));
    const gitdir = content.trim().replace(/^gitdir:\s*/, "");
    return gitdir.includes("/.git/worktrees/");
  });

/**
 * Resolve the main repo root from a linked worktree's .git pointer file.
 * Returns null if cwd is not a linked worktree or any read error occurs.
 */
export const resolveMainRepo = (
  cwd: string,
): Effect.Effect<string | null, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const gitPath = join(cwd, ".git");
    const exists = yield* fs.exists(gitPath).pipe(Effect.orElse(() => Effect.succeed(false)));
    if (!exists) return null;
    const info = yield* fs.stat(gitPath).pipe(Effect.orElse(() => Effect.succeed(null)));
    if (!info || info.type === "Directory") return null;
    const content = yield* fs.readFileString(gitPath).pipe(Effect.orElse(() => Effect.succeed("")));
    const gitdir = content.trim().replace(/^gitdir:\s*/, "");
    if (!gitdir.includes("/.git/worktrees/")) return null;
    return resolve(gitdir, "../../..");
  });

/**
 * Read the current branch name for a linked worktree.
 * Returns null for main checkouts, detached HEAD, deleted worktrees, or read errors.
 */
export const readWorktreeBranch = (
  cwd: string,
): Effect.Effect<string | null, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const gitPath = join(cwd, ".git");
    const exists = yield* fs.exists(gitPath).pipe(Effect.orElse(() => Effect.succeed(false)));
    if (!exists) return null;
    const info = yield* fs.stat(gitPath).pipe(Effect.orElse(() => Effect.succeed(null)));
    if (!info || info.type === "Directory") return null;
    const content = yield* fs.readFileString(gitPath).pipe(Effect.orElse(() => Effect.succeed("")));
    const gitdir = content.trim().replace(/^gitdir:\s*/, "");
    if (!gitdir.includes("/.git/worktrees/")) return null;
    const head = yield* fs.readFileString(join(gitdir, "HEAD")).pipe(
      Effect.orElse(() => Effect.succeed("")),
    );
    const m = head.trim().match(/^ref: refs\/heads\/(.+)$/);
    return m ? m[1] : null;
  });

/**
 * Read the gitdir path for a linked worktree (.git/worktrees/<id>/).
 * Returns null for main checkouts, submodules, or any error.
 */
export const readWorktreeGitdir = (
  cwd: string,
): Effect.Effect<string | null, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const gitPath = join(cwd, ".git");
    const exists = yield* fs.exists(gitPath).pipe(Effect.orElse(() => Effect.succeed(false)));
    if (!exists) return null;
    const info = yield* fs.stat(gitPath).pipe(Effect.orElse(() => Effect.succeed(null)));
    if (!info || info.type === "Directory") return null;
    const content = yield* fs.readFileString(gitPath).pipe(Effect.orElse(() => Effect.succeed("")));
    const gitdir = content.trim().replace(/^gitdir:\s*/, "");
    if (!gitdir.includes("/.git/worktrees/")) return null;
    return gitdir;
  });

/**
 * Resolve rw git mount paths for a linked worktree.
 * Propagates PlatformError — missing mounts silently break git inside the sandbox.
 */
export const resolveWorktreeGitRwMounts = (
  cwd: string,
): Effect.Effect<Array<{ path: string; label?: string }>, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const gitPath = join(cwd, ".git");
    const exists = yield* fs.exists(gitPath).pipe(Effect.orElse(() => Effect.succeed(false)));
    if (!exists) return [];
    const info = yield* fs.stat(gitPath).pipe(Effect.orElse(() => Effect.succeed(null)));
    if (!info || info.type === "Directory") return [];
    const content = yield* fs.readFileString(gitPath).pipe(Effect.orElse(() => Effect.succeed("")));
    const worktreeDir = content.trim().replace(/^gitdir:\s*/, "");
    if (!worktreeDir.includes("/.git/worktrees/")) return [];
    const mainGitDir = resolve(worktreeDir, "../..");
    return [
      { path: worktreeDir, label: "worktree git metadata" },
      { path: join(mainGitDir, "objects"), label: "git objects" },
    ];
  });

// ── repo root and branch existence ────────────────────────────────────────────

/**
 * Return the git repo root for the current directory, or null if not in a repo.
 * Absorbs git failure (no repo → null).
 */
export const gitRepoRoot = (): Effect.Effect<
  string | null,
  never,
  CommandExecutor
> =>
  commandString(makeCommand("git", "rev-parse", "--show-toplevel")).pipe(
    Effect.map((s) => s.trim() as string | null),
    Effect.catchAll(() => Effect.succeed(null)),
  );

/**
 * Return true if the given branch exists in the repo.
 * Absorbs git failure → false.
 */
export const branchExists = (
  repo: string,
  branch: string,
): Effect.Effect<boolean, never, CommandExecutor> =>
  commandExitCode(
    makeCommand(
      "git",
      "-C",
      repo,
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ),
  ).pipe(
    Effect.map((code) => code === 0),
    Effect.catchAll(() => Effect.succeed(false)),
  );

/**
 * List all linked worktrees for a git repository (excludes the main checkout).
 * Propagates PlatformError — a missing list silently drops sessions from the picker.
 */
export const listRepoWorktrees = (
  repo: string,
): Effect.Effect<string[], PlatformError, CommandExecutor> =>
  Effect.gen(function* () {
    const out = yield* commandString(
      makeCommand("git", "-C", repo, "worktree", "list", "--porcelain"),
    );
    const paths: string[] = [];
    let currentPath = "";
    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) {
        currentPath = line.slice(9).trim();
      } else if (line === "" && currentPath) {
        if (currentPath !== repo) paths.push(currentPath);
        currentPath = "";
      }
    }
    return paths;
  });
