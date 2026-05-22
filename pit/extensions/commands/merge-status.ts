/**
 * pit merge-status — footer indicator: is the worktree branch merged to master/main?
 *
 * Shows "✓ merged → <parent>" in the footer once the branch has been merged.
 * Updates live via the pit-escape subscribe op; 5-minute poll as safety net.
 *
 * Only active when PIT_ESCAPE_SOCKET is set (running under pit with a worktree session).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { useEscapeStatus } from "../status/use-escape-status.ts";

type IsMergedResponse =
  | {
      merged: boolean;
      branch: string | null;
      parentBranch: string | null;
      aheadCount: number;
      behindCount: number;
    }
  | { error: string };

/**
 * Pure function: convert ahead/behind counts into footer text.
 * Exported for testing.
 */
export const formatStatus = (
  aheadCount: number,
  behindCount: number,
  parentBranch: string,
): string => {
  if (aheadCount === 0 && behindCount === 0) {
    return `in sync with ${parentBranch}`;
  } else if (aheadCount > 0 && behindCount === 0) {
    const noun = aheadCount === 1 ? "commit" : "commits";
    return `${aheadCount} ${noun} ahead of ${parentBranch}`;
  } else if (aheadCount === 0 && behindCount > 0) {
    const noun = behindCount === 1 ? "commit" : "commits";
    return `${behindCount} ${noun} behind ${parentBranch}`;
  } else {
    return `${aheadCount} ahead \u00b7 ${behindCount} behind ${parentBranch}`;
  }
};

export default function (pi: ExtensionAPI) {
  const socketPath = process.env.PIT_ESCAPE_SOCKET;
  if (!socketPath) return;

  useEscapeStatus(pi, socketPath, "is-merged", "pit-merged", (resp) => {
    const r = resp as IsMergedResponse;
    if ("error" in r || !r.parentBranch) return undefined;
    return formatStatus(r.aheadCount, r.behindCount, r.parentBranch);
  });
}
