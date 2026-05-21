/**
 * pit loc-diff — footer indicator: lines changed vs the parent branch.
 *
 * Shows "+42 −7" (or "+42" / "−7" when only one side is non-zero) in the
 * footer, counting committed lines diffed from the merge-base with parent.
 * Hidden when the diff is zero. Updates live via the pit-escape subscribe op.
 *
 * Only active when PIT_ESCAPE_SOCKET is set (running under pit with a worktree session).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { useEscapeStatus } from "../escape/use-escape-status.ts";

type LocDiffResponse =
  | { insertions: number; deletions: number; parentBranch: string | null }
  | { error: string };

/**
 * Pure function: convert insertion/deletion counts into footer text.
 * Returns undefined when both are zero (hides the status item).
 * Exported for testing.
 */
export function formatLoc(
  insertions: number,
  deletions: number,
): string | undefined {
  if (insertions === 0 && deletions === 0) return undefined;
  if (insertions > 0 && deletions === 0) return `+${insertions}`;
  if (insertions === 0 && deletions > 0) return `\u2212${deletions}`;
  return `+${insertions} \u2212${deletions}`;
}

export default function (pi: ExtensionAPI) {
  const socketPath = process.env.PIT_ESCAPE_SOCKET;
  if (!socketPath) return;

  useEscapeStatus(pi, socketPath, "loc-diff", "pit-loc", (resp) => {
    const r = resp as LocDiffResponse;
    if ("error" in r) return undefined;
    return formatLoc(r.insertions, r.deletions);
  });
}
