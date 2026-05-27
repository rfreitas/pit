/**
 * branch-status op — unified worktree status for the footer.
 *
 * Returns raw numstat stdout for the client to parse (display-relevant,
 * no security significance), and resolved primitives for everything else.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { type NodeContext } from "@effect/platform-node/NodeContext";
import {
  resolveMainRepo,
  readWorktreeGitdir,
} from "../../../core/git/utils.ts";
import { gitEffect, detectParentBranch } from "./git.ts";

export type BranchStatusResult = {
  aheadCount: number;
  behindCount: number;
  parentBranch: string | null;
  aheadNumstat: string;
  stagedNumstat: string;
  unstagedNumstat: string;
  mergeInProgress: boolean;
  detachedHead: boolean;
};

export const opBranchStatus = (
  worktreePath: string,
): Effect.Effect<BranchStatusResult | { error: string }, never, NodeContext> =>
  Effect.gen(function* () {
    const mainRepo = yield* resolveMainRepo(worktreePath);

    // Detached HEAD: symbolic-ref exits non-zero when HEAD is a SHA
    const symRef = yield* gitEffect(
      ["symbolic-ref", "--quiet", "HEAD"],
      worktreePath,
    );
    const detachedHead = symRef.code !== 0;

    // Staged and unstaged are always available
    const [stagedR, unstagedR] = yield* Effect.all(
      [
        gitEffect(["diff", "--cached", "--numstat"], worktreePath),
        gitEffect(["diff", "--numstat"], worktreePath),
      ],
      { concurrency: "unbounded" },
    );

    const parentBranch = mainRepo
      ? yield* Effect.sync(() => detectParentBranch(mainRepo))
      : null;

    const gitdir = yield* readWorktreeGitdir(worktreePath);
    const mergeInProgress = gitdir
      ? existsSync(join(gitdir, "MERGE_HEAD"))
      : false;

    if (!parentBranch) {
      return {
        aheadCount: 0,
        behindCount: 0,
        parentBranch: null,
        aheadNumstat: "",
        stagedNumstat: stagedR.stdout,
        unstagedNumstat: unstagedR.stdout,
        mergeInProgress,
        detachedHead,
      };
    }

    const baseR = yield* gitEffect(
      ["merge-base", "HEAD", parentBranch],
      worktreePath,
    );
    const base = baseR.stdout.trim();

    if (!base) {
      return {
        aheadCount: 0,
        behindCount: 0,
        parentBranch,
        aheadNumstat: "",
        stagedNumstat: stagedR.stdout,
        unstagedNumstat: unstagedR.stdout,
        mergeInProgress,
        detachedHead,
      };
    }

    const [aheadNumstatR, aheadCountR, behindCountR] = yield* Effect.all(
      [
        gitEffect(["diff", "--numstat", base, "HEAD"], worktreePath),
        gitEffect(["rev-list", "--count", `${parentBranch}..HEAD`], worktreePath),
        gitEffect(["rev-list", "--count", `HEAD..${parentBranch}`], worktreePath),
      ],
      { concurrency: "unbounded" },
    );

    return {
      aheadCount: parseInt(aheadCountR.stdout.trim(), 10) || 0,
      behindCount: parseInt(behindCountR.stdout.trim(), 10) || 0,
      parentBranch,
      aheadNumstat: aheadNumstatR.stdout,
      stagedNumstat: stagedR.stdout,
      unstagedNumstat: unstagedR.stdout,
      mergeInProgress,
      detachedHead,
    };
  });
