/**
 * pit branch-status — unified footer indicator.
 *
 * Shows committed LOC vs parent, ahead/behind counts, staged and unstaged
 * line counts. Replaces the separate merge-status and loc-diff extensions.
 *
 * Format: "2 commits ahead (+42 −7) of main, 3 behind · staged (+5) · unstaged (+3 −1)"
 *
 * Only active when PIT_ESCAPE_SOCKET is set (running under pit with a worktree session).
 */

import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { useEscapeStatus } from "./helpers.ts";
import type { BranchStatusResult } from "../../escape/core/ops/branch-status.ts";

// ── types ─────────────────────────────────────────────────────────────────────

export type ParsedBranchStatus = {
  aheadCount: number;
  aheadInsertions: number;
  aheadDeletions: number;
  aheadBinaryFiles: number;
  behindCount: number;
  parentBranch: string | null;
  stagedInsertions: number;
  stagedDeletions: number;
  unstagedInsertions: number;
  unstagedDeletions: number;
  detachedHead: boolean;
  mergeInProgress: boolean;
};

// ── parseNumstat ──────────────────────────────────────────────────────────────

/**
 * Parse `git diff --numstat` stdout into insertion/deletion/binary counts.
 * Binary files appear as "-\t-\tfilename" — stable, localisation-independent.
 * Exported for testing.
 */
export const parseNumstat = (
  stdout: string,
): { insertions: number; deletions: number; binaryFiles: number } =>
  stdout.split(/\r?\n/).reduce(
    (acc, line) => {
      if (!line.trim()) return acc;
      if (line.startsWith("-\t-\t")) return { ...acc, binaryFiles: acc.binaryFiles + 1 };
      const parts = line.split("\t");
      return {
        ...acc,
        insertions: acc.insertions + (parseInt(parts[0], 10) || 0),
        deletions:  acc.deletions  + (parseInt(parts[1], 10) || 0),
      };
    },
    { insertions: 0, deletions: 0, binaryFiles: 0 },
  );

// ── formatBranchStatus ────────────────────────────────────────────────────────

const DOT = " \u00b7 ";
const MINUS = "\u2212";

const formatAheadLoc = (ins: number, del: number, bins: number): string => {
  const textPart =
    ins > 0 && del > 0 ? `+${ins} ${MINUS}${del}` :
    ins > 0             ? `+${ins}` :
    del > 0             ? `${MINUS}${del}` :
    null;
  const binaryPart =
    bins > 0 ? `${bins} ${bins === 1 ? "binary file" : "binary files"}` : null;
  if (textPart && binaryPart) return `${textPart}, ${binaryPart}`;
  if (textPart) return textPart;
  if (binaryPart) return binaryPart;
  return "+0"; // empty or permission-only commits
};

const formatDirtySegment = (
  label: string,
  ins: number,
  del: number,
): string => {
  const loc =
    ins > 0 && del > 0 ? `+${ins} ${MINUS}${del}` :
    ins > 0             ? `+${ins}` :
                          `${MINUS}${del}`;
  return `${label} (${loc})`;
};

/**
 * Convert a parsed branch status into a footer string.
 * Returns undefined when there is nothing to show (hidden footer item).
 * Exported for testing.
 */
export const formatBranchStatus = (
  s: Readonly<ParsedBranchStatus>,
): string | undefined => {
  const hasDirty =
    s.stagedInsertions > 0 || s.stagedDeletions > 0 ||
    s.unstagedInsertions > 0 || s.unstagedDeletions > 0;

  // Detached HEAD or no parent branch — hide when clean
  if (s.detachedHead || !s.parentBranch) {
    if (!hasDirty) return undefined;
    return [
      s.stagedInsertions > 0 || s.stagedDeletions > 0
        ? formatDirtySegment("staged", s.stagedInsertions, s.stagedDeletions)
        : null,
      s.unstagedInsertions > 0 || s.unstagedDeletions > 0
        ? formatDirtySegment("unstaged", s.unstagedInsertions, s.unstagedDeletions)
        : null,
      s.detachedHead ? "detached HEAD" : "no parent branch",
    ].filter((x): x is string => x !== null).join(DOT);
  }

  const aheadNoun  = s.aheadCount  === 1 ? "commit" : "commits";
  const behindNoun = s.behindCount === 1 ? "commit" : "commits";

  const syncSegment =
    s.aheadCount === 0 && s.behindCount === 0
      ? `in sync with ${s.parentBranch}`
      : s.aheadCount > 0 && s.behindCount === 0
        ? `${s.aheadCount} ${aheadNoun} (${formatAheadLoc(s.aheadInsertions, s.aheadDeletions, s.aheadBinaryFiles)}) ahead of ${s.parentBranch}`
        : s.aheadCount === 0
          ? `${s.behindCount} ${behindNoun} behind ${s.parentBranch}`
          : `${s.aheadCount} ${aheadNoun} (${formatAheadLoc(s.aheadInsertions, s.aheadDeletions, s.aheadBinaryFiles)}) ahead of ${s.parentBranch}, ${s.behindCount} behind`;

  return [
    s.mergeInProgress ? "merge in progress" : null,
    syncSegment,
    s.stagedInsertions > 0 || s.stagedDeletions > 0
      ? formatDirtySegment("staged", s.stagedInsertions, s.stagedDeletions)
      : null,
    s.unstagedInsertions > 0 || s.unstagedDeletions > 0
      ? formatDirtySegment("unstaged", s.unstagedInsertions, s.unstagedDeletions)
      : null,
  ].filter((x): x is string => x !== null).join(DOT);
};

// ── extension factory ─────────────────────────────────────────────────────────

export const createBranchStatus = (
  socketPath: string,
  token: string,
): ExtensionFactory => (pi: ExtensionAPI) => {
  useEscapeStatus(pi, socketPath, token, "branch-status", "pit-status", (resp) => {
    const r = resp as BranchStatusResult | { error: string };
    if ("error" in r) return undefined;
    const ahead = parseNumstat(r.aheadNumstat);
    const staged = parseNumstat(r.stagedNumstat);
    const unstaged = parseNumstat(r.unstagedNumstat);
    return formatBranchStatus({
      aheadCount: r.aheadCount,
      aheadInsertions: ahead.insertions,
      aheadDeletions: ahead.deletions,
      aheadBinaryFiles: ahead.binaryFiles,
      behindCount: r.behindCount,
      parentBranch: r.parentBranch,
      stagedInsertions: staged.insertions,
      stagedDeletions: staged.deletions,
      unstagedInsertions: unstaged.insertions,
      unstagedDeletions: unstaged.deletions,
      detachedHead: r.detachedHead,
      mergeInProgress: r.mergeInProgress,
    });
  });
};
