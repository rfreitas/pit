/**
 * /merge effect — multi-phase merge workflow.
 *
 * Calls ctx.ui.notify for progress at each phase (these are inherent to the
 * workflow, not error display). Unexpected errors propagate to the command
 * boundary (index.ts).
 */

import { Effect } from "effect";
import type { ExtensionCommandContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sendEffect, isOk, errMsg, type EscapeResult } from "../../escape/client.ts";

type StateResponse = {
  branch: string | null;
  mergeInProgress: boolean;
  conflicts: string[];
  parentBranch: string | null;
  behindParent: boolean;
};

export const mergeEffect = (
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  socketPath: string,
  parentBranchArg: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const stateResp = yield* sendEffect(socketPath, { op: "get-state" });
    if ("error" in stateResp) {
      ctx.ui.notify(`pit-escape error: ${stateResp.error}`, "error");
      return;
    }
    const state = stateResp as unknown as StateResponse;

    const parentBranch = parentBranchArg || state.parentBranch;
    if (!parentBranch) {
      ctx.ui.notify(
        "Could not detect parent branch — run `/merge <branch>` to specify",
        "error",
      );
      return;
    }

    // ── Phase 1: merge already in progress ──────────────────────────────
    if (state.mergeInProgress) {
      if (state.conflicts.length > 0) {
        ctx.ui.notify("Merge conflicts — agent notified", "warning");
        pi.sendUserMessage(
          `There are unresolved merge conflicts:\n\`\`\`\n${state.conflicts.join("\n")}\n\`\`\`\nPlease resolve them, commit the merge, then run \`/merge\` again.`,
        );
      } else {
        ctx.ui.notify("Merge in progress but clean — please commit it first", "info");
      }
      return;
    }

    // ── Phase 2: worktree behind parent — merge parent in ───────────────
    if (state.behindParent) {
      ctx.ui.notify(`Merging ${parentBranch} into branch...`, "info");
      const fwd = yield* sendEffect(socketPath, { op: "git", args: ["merge", parentBranch] });

      if (!isOk(fwd)) {
        const afterResp = yield* sendEffect(socketPath, { op: "get-state" });
        const after = afterResp as unknown as StateResponse;
        if (after.mergeInProgress && after.conflicts.length > 0) {
          ctx.ui.notify("Forward merge has conflicts — agent notified", "warning");
          pi.sendUserMessage(
            `Merging \`${parentBranch}\` into your branch created conflicts:\n\`\`\`\n${after.conflicts.join("\n")}\n\`\`\`\nPlease resolve them, commit the merge, then run \`/merge\` again.`,
          );
        } else {
          ctx.ui.notify(`Forward merge failed: ${errMsg(fwd)}`, "error");
        }
        return;
      }
      ctx.ui.notify(`Merged ${parentBranch} into branch`, "info");
    }

    // ── Phase 3: fast-forward parent branch to worktree branch ──────────
    ctx.ui.notify(`Merging ${state.branch ?? "branch"} into ${parentBranch}...`, "info");
    const result: EscapeResult = yield* sendEffect(socketPath, {
      op: "merge-to-parent",
      parentBranch,
    });

    if (!isOk(result)) {
      ctx.ui.notify(`Failed to merge into ${parentBranch}: ${errMsg(result)}`, "error");
      return;
    }
    ctx.ui.notify(`Merged into ${parentBranch} \u2713`, "info");
  });
