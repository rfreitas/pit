/**
 * Shared type definitions for pit.
 * No logic, no imports beyond TypeScript primitives.
 * Imported by pure.ts, utils.ts, pit.ts, and pit-escape.ts.
 */

// ── session metadata ──────────────────────────────────────────────────────────

export interface PitMetadata {
  id: string;
  /** repo root, or original cwd for no-tree sessions */
  repo: string;
  /** worktree path, or original cwd for no-tree sessions */
  worktree: string;
  /** git branch name; empty string for no-tree sessions */
  branch: string;
  created: string;
  mode: "worktree" | "no-tree";
  /** why no-tree: absent git repo, user explicitly passed -nt/--no-tree, or cwd is already a linked worktree */
  noTreeReason?: "no-repo" | "forced" | "linked-worktree";
}

export interface WorktreeResult {
  mode: "worktree" | "no-tree";
  cwd: string;
  meta: PitMetadata;
}

// ── sandbox mounts ────────────────────────────────────────────────────────────

/**
 * A single bwrap mount entry. Drives both the bwrap arg list in pit.ts
 * and the sandbox section of the session announcement, so the two stay
 * in sync automatically.
 */
export interface RoMount {
  path: string;
  label?: string;
  /** Use --ro-bind-try instead of --ro-bind (silently skipped if missing). */
  optional?: boolean;
}

export interface RwMount {
  path: string;
  label?: string;
}

export interface OverlayMount {
  /** Lower (read-only) directory — the parent repo's unversioned dir. */
  src: string;
  /** Mount point inside the sandbox — the worktree's corresponding path. */
  dest: string;
  /** Display label shown in the sandbox announcement (e.g. the relative path). */
  label?: string;
}

export interface SandboxMounts {
  ro: RoMount[];
  rw: RwMount[];
  /**
   * Ephemeral overlay mounts: the parent repo's unversioned dirs are overlaid
   * onto the worktree using a tmpfs upper layer. Reads come from the parent;
   * writes succeed but vanish when the session ends.
   */
  overlay?: OverlayMount[];
}

// ── pit config ────────────────────────────────────────────────────────────────

/**
 * Pit-specific config, read from <pitDir>/config.json.
 * Absent file = empty config (no filtering).
 */
export interface PitConfig {
  /** Package sources to strip from settings.json when launching sandboxed. */
  denyPackages?: string[];
}

// ── flag parsing ──────────────────────────────────────────────────────────────

export interface ParsedFlags {
  sandbox: boolean;
  noTree: boolean;
  filteredArgv: string[];
}

// ── linked-worktree session ───────────────────────────────────────────────────

export interface LinkedWorktreeSession {
  /** "resume" = found an existing pit session; "new" = created a fresh no-tree session. */
  kind: "resume" | "new";
  sessionFile: string;
  meta: PitMetadata;
}
