/**
 * loc-diff op — lines inserted/deleted vs the parent branch.
 * No display logic — errors propagate to the socket boundary (server.ts).
 */

import * as Effect from "effect/Effect";
import { type NodeContext } from "@effect/platform-node/NodeContext";
import { resolveMainRepo, readWorktreeBranch } from "../../core/git/utils.ts";
import { gitEffect, detectParentBranch } from "./git.ts";

export const opLocDiff = (
  worktreePath: string,
): Effect.Effect<object, never, NodeContext> =>
  Effect.gen(function* () {
    const branch = yield* readWorktreeBranch(worktreePath);
    const mainRepo = yield* resolveMainRepo(worktreePath);
    if (!branch || !mainRepo) {
      return { insertions: 0, deletions: 0, parentBranch: null };
    }
    const parentBranch = yield* Effect.sync(() => detectParentBranch(mainRepo));
    if (!parentBranch) {
      return { insertions: 0, deletions: 0, parentBranch: null };
    }
    const baseR = yield* gitEffect(["merge-base", "HEAD", parentBranch], worktreePath);
    const base = baseR.stdout.trim();
    if (!base) return { insertions: 0, deletions: 0, parentBranch };
    const diffR = yield* gitEffect(["diff", "--shortstat", base], worktreePath);
    const text = diffR.stdout.trim();
    const insMatch = text.match(/(\d+) insertion/);
    const delMatch = text.match(/(\d+) deletion/);
    return {
      insertions: insMatch ? parseInt(insMatch[1], 10) : 0,
      deletions: delMatch ? parseInt(delMatch[1], 10) : 0,
      parentBranch,
    };
  });
