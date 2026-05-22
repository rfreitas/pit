/**
 * merge-to-parent and is-merged ops.
 * No display logic — errors propagate to the socket boundary (server.ts).
 */

import { execFileSync } from "node:child_process";
import * as Effect from "effect/Effect";
import { type NodeContext } from "@effect/platform-node/NodeContext";
import { resolveMainRepo, readWorktreeBranch } from "../../core/git/utils.ts";
import { gitEffect, detectParentBranch } from "./git.ts";

export const opMergeToParent = (
  parentBranch: string,
  worktreePath: string,
): Effect.Effect<object, never, NodeContext> =>
  Effect.gen(function* () {
    const mainRepo = yield* resolveMainRepo(worktreePath);
    if (!mainRepo) return { error: "Cannot resolve main repo from worktree" };

    const branch = yield* readWorktreeBranch(worktreePath);
    if (!branch) return { error: "Cannot determine current branch (detached HEAD?)" };

    const checkedOut = (() => {
      try {
        return {
          ok: true as const,
          value: execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: mainRepo, encoding: "utf8" }).trim(),
        };
      } catch (e) { return { ok: false as const, error: (e as Error).message }; }
    })();
    if (!checkedOut.ok) return { error: `Cannot read main repo HEAD: ${checkedOut.error}` };
    if (checkedOut.value !== parentBranch) {
      return { error: `Main repo has '${checkedOut.value}' checked out, not '${parentBranch}'. Check out '${parentBranch}' first.` };
    }

    return yield* gitEffect(["merge", "--ff-only", branch], mainRepo);
  });

export const opIsMerged = (
  worktreePath: string,
): Effect.Effect<object, never, NodeContext> =>
  Effect.gen(function* () {
    const branch = yield* readWorktreeBranch(worktreePath);
    const mainRepo = yield* resolveMainRepo(worktreePath);
    if (!branch || !mainRepo) {
      return { merged: false, branch: branch ?? null, parentBranch: null, aheadCount: 0, behindCount: 0 };
    }
    const parentBranch = yield* Effect.sync(() => detectParentBranch(mainRepo));
    if (!parentBranch) {
      return { merged: false, branch, parentBranch: null, aheadCount: 0, behindCount: 0 };
    }
    const [mr, countR, behindR] = yield* Effect.all([
      gitEffect(["merge-base", "--is-ancestor", branch, parentBranch], mainRepo),
      gitEffect(["rev-list", "--count", `${parentBranch}..HEAD`], worktreePath),
      gitEffect(["rev-list", "--count", `HEAD..${parentBranch}`], worktreePath),
    ]);
    const aheadCount = parseInt(countR.stdout.trim(), 10) || 0;
    const behindCount = parseInt(behindR.stdout.trim(), 10) || 0;
    return { merged: mr.code === 0, branch, parentBranch, aheadCount, behindCount };
  });
