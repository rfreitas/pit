/**
 * Worktree IO — subprocess calls to create and manage git worktrees.
 */

import { existsSync } from "node:fs";
import * as Effect from "effect/Effect";
import { make as makeCommand, exitCode as commandExitCode } from "@effect/platform/Command";
import { FileSystem } from "@effect/platform/FileSystem";
import { CommandExecutor } from "@effect/platform/CommandExecutor";
import { gitRepoRoot, branchExists } from "../git/utils.ts";
import { genId, buildNoTreeMeta, buildWorktreeMeta, worktreePathFor } from "./pure.ts";
import type { PitMetadata, WorktreeResult } from "../../types.ts";
import { WorktreeCreationError, WorktreeMissingError } from "../../errors.ts";

// ── worktree creation / recreation ────────────────────────────────────────────

export const createWorktreeEffect = ({
  branch,
  worktree,
}: Readonly<{
  branch: string;
  worktree: string;
}>): Effect.Effect<void, WorktreeCreationError, CommandExecutor> =>
  Effect.gen(function* () {
    yield* Effect.logInfo("pit: creating worktree");
    yield* Effect.logInfo(`  branch:   ${branch}`);
    yield* Effect.logInfo(`  worktree: ${worktree}`);
    yield* commandExitCode(
      makeCommand("git", "worktree", "add", "-b", branch, worktree, "HEAD"),
    ).pipe(
      Effect.flatMap((code) =>
        code === 0
          ? Effect.void
          : Effect.fail(new WorktreeCreationError({ message: `git worktree add exited ${code}` })),
      ),
      Effect.catchTag("WorktreeCreationError", (e) => Effect.fail(e)),
      Effect.catchAll((e) =>
        Effect.fail(new WorktreeCreationError({ message: String(e) })),
      ),
    );
  });

export const createFreshWorktreeEffect = ({
  repo,
  branch,
  worktree,
}: Readonly<{
  repo: string;
  branch: string;
  worktree: string;
}>): Effect.Effect<void, WorktreeCreationError, CommandExecutor> =>
  Effect.gen(function* () {
    yield* Effect.logInfo("pit: creating fresh worktree");
    yield* Effect.logInfo(`  branch:   ${branch}`);
    yield* Effect.logInfo(`  worktree: ${worktree}`);
    // Create off the main repo's HEAD
    yield* commandExitCode(
      makeCommand("git", "-C", repo, "worktree", "add", "-b", branch, worktree, "HEAD"),
    ).pipe(
      Effect.flatMap((code) =>
        code === 0
          ? Effect.void
          : Effect.fail(new WorktreeCreationError({ message: `git worktree add exited ${code}` })),
      ),
      Effect.catchTag("WorktreeCreationError", (e) => Effect.fail(e)),
      Effect.catchAll((e) =>
        Effect.fail(new WorktreeCreationError({ message: String(e) })),
      ),
    );
  });

export const recreateWorktreeEffect = ({
  repo,
  branch,
  worktree,
}: Readonly<{
  repo: string;
  branch: string;
  worktree: string;
}>): Effect.Effect<
  void,
  WorktreeMissingError | WorktreeCreationError,
  CommandExecutor
> =>
  Effect.gen(function* () {
    yield* Effect.logWarning("pit: worktree missing, attempting to recreate…");
    const exists = yield* branchExists(repo, branch);
    if (!exists) {
      yield* Effect.fail(new WorktreeMissingError({ branch }));
    }
    yield* Effect.all([
      commandExitCode(makeCommand("git", "-C", repo, "worktree", "prune")).pipe(
        Effect.ignore,
      ),
      commandExitCode(
        makeCommand("git", "-C", repo, "worktree", "add", worktree, branch),
      ).pipe(
        Effect.flatMap((code) =>
          code === 0
            ? Effect.logInfo(`pit: worktree recreated at ${worktree}`)
            : Effect.fail(new WorktreeCreationError({ message: `git worktree add exited ${code}` })),
        ),
        Effect.catchTag("WorktreeCreationError", (e) => Effect.fail(e)),
        Effect.catchAll((e) =>
          Effect.fail(new WorktreeCreationError({ message: String(e) })),
        ),
      ),
    ]);
  });

// ── worktree check ────────────────────────────────────────────────────────────

/**
 * When resuming an existing pit session, callers pass both the stored metadata
 * and the cwd from the session file header. The session header cwd is
 * authoritative — it may differ from any worktree field in old session files
 * (e.g. after a /handoff moved the session to a different directory).
 */
export interface ExistingSession {
  meta: PitMetadata;
  /** cwd from the session file header (SessionManager.getCwd()). */
  cwd: string;
}

export const worktreeCheckEffect = (
  existing?: ExistingSession,
  forceNoTree = false,
): Effect.Effect<
  WorktreeResult,
  WorktreeMissingError | WorktreeCreationError,
  CommandExecutor | FileSystem
> =>
  Effect.gen(function* () {
    if (existing) {
      const { meta, cwd } = existing;
      if (!existsSync(cwd)) {
        // Directory missing — use branch cache for recovery.
        // branch === "" means no-tree: nothing to recreate.
        if (meta.branch) {
          yield* recreateWorktreeEffect({ repo: meta.repo, branch: meta.branch, worktree: cwd });
        }
        return { cwd, meta };
      }
      // Directory exists — mode is derived from live git state, not metadata.
      // (meta is still returned for repo/branch cache refresh by the caller)
      return { cwd, meta };
    }

    const repo = yield* gitRepoRoot();
    const cwd = process.cwd();

    if (!repo || forceNoTree) {
      return { cwd, meta: buildNoTreeMeta(repo ?? cwd) };
    }

    const id = genId();
    const branch = `pi/${id}`;
    const worktreePath = worktreePathFor(repo, id);
    yield* createWorktreeEffect({ branch, worktree: worktreePath });
    return { cwd: worktreePath, meta: buildWorktreeMeta(repo, branch) };
  });
