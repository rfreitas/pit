/**
 * Pure worktree logic — no filesystem, no process spawning.
 * Builds PitMetadata structs and parses pit CLI flags.
 */

import { join, dirname, basename } from "node:path";
import { randomBytes } from "node:crypto";
import type { PitMetadata, ParsedFlags } from "../types.ts";

// ── id generation ─────────────────────────────────────────────────────────────

/** Generate an 8-hex-character random id for worktrees and sessions. */
export const genId = (): string  => {
  return randomBytes(4).toString("hex");
}

// ── metadata builders ─────────────────────────────────────────────────────────

/**
 * Build a no-tree PitMetadata struct.
 * Callers supply id + created so the IO boundary (genId, new Date) stays outside.
 */
export const buildNoTreeMeta = (
  cwd: string,
  repo: string,
  reason: PitMetadata["noTreeReason"],
  id: string,
  created: string,
): PitMetadata  => {
  return { id, repo, created, worktree: cwd, branch: "", mode: "no-tree", noTreeReason: reason };
}

/**
 * Build a worktree PitMetadata struct.
 * Derives the worktree path and branch name from repo + id.
 * Callers supply id + created so the IO boundary stays outside.
 */
export const buildWorktreeMeta = (repo: string, id: string, created: string): PitMetadata  => {
  return {
    id,
    repo,
    created,
    worktree: join(dirname(repo), `${basename(repo)}-wt-${id}`),
    branch: `pi/${id}`,
    mode: "worktree",
  };
}

// ── flag parsing ──────────────────────────────────────────────────────────────

/**
 * Strip pit-only flags from argv, returning the remainder for pi passthrough.
 * --no-sandbox and -nt/--no-tree are pit-only; everything else forwards to pi.
 *
 * --no-session implies noTree: a session is the only way to reference a worktree
 * from pit. Without a session there is nothing to track, resume, or clean up the
 * worktree against, so creating one would leave an orphan branch.
 * The flag still forwards to pi unchanged.
 */
export const parseFlags = (argv: string[]): ParsedFlags  => {
  return argv.reduce<ParsedFlags>(
    ({ sandbox, noTree, filteredArgv }, arg) => {
      if (arg === "--no-sandbox") return { sandbox: false, noTree, filteredArgv };
      if (arg === "-nt" || arg === "--no-tree") return { sandbox, noTree: true, filteredArgv };
      if (arg === "--no-session") return { sandbox, noTree: true, filteredArgv: [...filteredArgv, arg] };
      return { sandbox, noTree, filteredArgv: [...filteredArgv, arg] };
    },
    { sandbox: true, noTree: false, filteredArgv: [] },
  );
}
