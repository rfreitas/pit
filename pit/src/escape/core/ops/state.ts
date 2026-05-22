/**
 * get-state op — returns the current worktree state.
 * No display logic — errors propagate to the socket boundary (server.ts).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { type NodeContext } from "@effect/platform-node/NodeContext";
import { resolveMainRepo, readWorktreeBranch, readWorktreeGitdir } from "../../../core/git/utils.ts";
import { gitEffect, detectParentBranch } from "./git.ts";

export const opGetState = (
  worktreePath: string,
): Effect.Effect<object, never, NodeContext> =>
  Effect.gen(function* () {
    const branch = yield* readWorktreeBranch(worktreePath);
    const mainRepo = yield* resolveMainRepo(worktreePath);
    const parentBranch = mainRepo
      ? yield* Effect.sync(() => detectParentBranch(mainRepo))
      : null;

    const gitdir = yield* readWorktreeGitdir(worktreePath);
    const mergeInProgress = gitdir ? existsSync(join(gitdir, "MERGE_HEAD")) : false;

    const conflicts = mergeInProgress
      ? (yield* gitEffect(["diff", "--name-only", "--diff-filter=U"], worktreePath)).stdout
          .trim().split("\n").filter(Boolean)
      : [];

    const behindParent = (parentBranch && mainRepo)
      ? (yield* gitEffect(["log", "--oneline", `HEAD..${parentBranch}`], worktreePath)).stdout.trim().length > 0
      : false;

    return { branch, mergeInProgress, conflicts, parentBranch, behindParent };
  });
