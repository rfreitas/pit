/**
 * Shared type definitions for pit.
 * No logic, no imports beyond TypeScript primitives.
 * Imported by pure.ts, utils.ts, pit.ts, and pit-escape.ts.
 */

// ── session metadata ──────────────────────────────────────────────────────────

export interface PitMetadata {
  /** main repo path — recovery cache for when the worktree directory is gone */
  repo: string;
  /** checked-out branch — recovery cache; empty string for no-tree sessions */
  branch: string;
}

export interface WorktreeResult {
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
  /** Use --bind-try instead of --bind (silently skipped if source missing). */
  optional?: boolean;
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
  rw: RwMount[];
  /**
   * Read denylist — paths that should not be readable inside the sandbox.
   * Both platforms use this: Linux uses --tmpfs to hide, macOS uses SBPL deny rules.
   */
  readDeny: RoMount[];
  /**
   * Ephemeral overlay mounts: the parent repo's unversioned dirs are overlaid
   * onto the worktree using a tmpfs upper layer. Reads come from the parent;
   * writes succeed but vanish when the session ends.
   * Linux only — not supported on macOS (feature gap, sandbox-exec has no overlayfs).
   */
  overlay?: OverlayMount[];
  /**
   * Which sandbox backend enforces this policy.
   * Drives the sandbox announcement header text.
   * Defaults to 'bwrap' when absent (backward compat).
   */
  backend?: 'bwrap' | 'sandbox-exec';
}

// ── pit config ────────────────────────────────────────────────────────────────

/**
 * Pit-specific config, read from <pitDir>/config.json.
 * Absent file = empty config (no filtering).
 */
export interface PitConfig {
  /**
   * Extra env var names to pass into the sandbox on top of the built-in
   * defaults. Values are taken from the host env at launch time; absent vars
   * are silently skipped. Example: ["http_proxy", "https_proxy"].
   */
  allowEnv?: string[];
  /** Extension paths passed as --extension flags only in non-sandbox mode. */
  nonSandboxExtensions?: string[];
  /**
   * Per-platform read/write policy overrides.
   * denyRead:  both platforms → adds to readDeny[].
   * allowWrite: both platforms → adds to rw[].
   */
  sandbox?: {
    denyRead?: string[];
    allowWrite?: string[];
  };
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
