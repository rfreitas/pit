/**
 * Worktree IO — subprocess calls to create and manage git worktrees.
 */

import { existsSync } from "node:fs";
import * as Effect from "effect/Effect";
import { make as makeCommand, exitCode as commandExitCode } from "@effect/platform/Command";
import { FileSystem } from "@effect/platform/FileSystem";
import { CommandExecutor } from "@effect/platform/CommandExecutor";
import { gitRepoRoot, branchExists } from "../git/utils.ts";
import { genId, buildNoTreeMeta, buildWorktreeMeta } from "./pure.ts";
import type { PitMetadata, WorktreeResult } from "../types.ts";
import { WorktreeCreationError, WorktreeMissingError } from "../errors.ts";

// ── worktree creation / recreation ────────────────────────────────────────────

export const createWorktreeEffect = ({
  branch,
  worktree,
}: {
  branch: string;
  worktree: string;
}): Effect.Effect<void, WorktreeCreationError, CommandExecutor> =>
  Effect.gen(function* () {
    console.error("pit: creating worktree");
    console.error(`  branch:   ${branch}`);
    console.error(`  worktree: ${worktree}`);
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
}: {
  repo: string;
  branch: string;
  worktree: string;
}): Effect.Effect<
  void,
  WorktreeMissingError | WorktreeCreationError,
  CommandExecutor
> =>
  Effect.gen(function* () {
    console.error("pit: worktree missing, attempting to recreate…");
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
            ? Effect.sync(() => console.error(`pit: worktree recreated at ${worktree}`))
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

export const worktreeCheckEffect = (
  existingMeta?: PitMetadata,
  forceNoTree = false,
): Effect.Effect<
  WorktreeResult,
  WorktreeMissingError | WorktreeCreationError,
  CommandExecutor | FileSystem
> =>
  Effect.gen(function* () {
    if (existingMeta) {
      if (existingMeta.mode === "no-tree") {
        return { mode: "no-tree" as const, cwd: existingMeta.worktree, meta: existingMeta };
      }
      if (!existsSync(existingMeta.worktree)) {
        yield* recreateWorktreeEffect(existingMeta);
      }
      return { mode: "worktree" as const, cwd: existingMeta.worktree, meta: existingMeta };
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

    const meta = buildWorktreeMeta(repo, id, created);
    yield* createWorktreeEffect(meta);
    return { mode: "worktree" as const, cwd: meta.worktree, meta };
  });
