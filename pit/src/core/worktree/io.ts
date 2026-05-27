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
      commandExitCode(makeCommand("git", "worktree", "prune", "-C", repo)).pipe(
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
      if (meta.mode === "no-tree") {
        return { mode: "no-tree" as const, cwd, meta };
      }
      if (!existsSync(cwd)) {
        yield* recreateWorktreeEffect({ repo: meta.repo, branch: meta.branch, worktree: cwd });
      }
      return { mode: "worktree" as const, cwd, meta };
    }

    const repo = yield* gitRepoRoot();
    const cwd = process.cwd();
    const id = genId();
    const created = new Date().toISOString();

    if (!repo) {
      return {
        mode: "no-tree" as const,
        cwd,
        meta: buildNoTreeMeta(cwd, cwd, "no-repo", id, created),
      };
    }
    if (forceNoTree) {
      return {
        mode: "no-tree" as const,
        cwd,
        meta: buildNoTreeMeta(cwd, repo, "forced", id, created),
      };
    }

    const worktreePath = worktreePathFor(repo, id);
    const meta = buildWorktreeMeta(repo, id, created);
    yield* createWorktreeEffect({ branch: meta.branch, worktree: worktreePath });
    return { mode: "worktree" as const, cwd: worktreePath, meta };
  });
