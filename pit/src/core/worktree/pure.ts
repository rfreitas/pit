/**
 * Pure worktree logic — no filesystem, no process spawning.
 * Builds PitMetadata structs and parses pit CLI flags.
 */

import { join, dirname, basename } from "node:path";
import { randomBytes } from "node:crypto";
import type { PitMetadata, ParsedFlags } from "../../types.ts";

// ── id generation ─────────────────────────────────────────────────────────────

/** Generate an 8-hex-character random id for worktrees and sessions. */
export const genId = (): string  => {
  return randomBytes(4).toString("hex");
}

// ── metadata builders ─────────────────────────────────────────────────────────

/**
 * Compute the worktree directory path for a given repo and id.
 * The path is stored in the session header's cwd, not in PitMetadata.
 */
export const worktreePathFor = (repo: string, id: string): string =>
  join(dirname(repo), `${basename(repo)}-wt-${id}`);

/**
 * Build a no-tree PitMetadata struct.
 * Only repo is stored — branch is empty for no-tree sessions.
 */
export const buildNoTreeMeta = (repo: string): PitMetadata => ({ repo, branch: "" });

/**
 * Build a worktree PitMetadata struct.
 * Branch is passed explicitly (derived from id by the caller: `pi/${id}`).
 * The worktree path is NOT stored in metadata — it lives in the session header's cwd.
 * Use worktreePathFor(repo, id) to get the path.
 */
export const buildWorktreeMeta = (repo: string, branch: string): PitMetadata => ({ repo, branch });

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
      if (arg === "--no-sandbox" || arg === "-ns") return { sandbox: false, noTree, filteredArgv };
      if (arg === "-nt" || arg === "--no-tree") return { sandbox, noTree: true, filteredArgv };
      if (arg === "--no-session") return { sandbox, noTree: true, filteredArgv: [...filteredArgv, arg] };
      return { sandbox, noTree, filteredArgv: [...filteredArgv, arg] };
    },
    { sandbox: true, noTree: false, filteredArgv: [] },
  );
}
