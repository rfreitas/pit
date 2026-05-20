/**
 * Pure functions for pit — no filesystem, no process spawning, no network.
 * Every export is a deterministic data→data transformation (crypto.randomBytes
 * is acceptable as a pseudo-pure entropy source, same as genId has always been).
 *
 * Imports: only node:path, node:crypto, CURRENT_SESSION_VERSION constant, and
 * local types.  Nothing here may import node:fs or node:child_process.
 */

import * as path from "node:path";
import * as crypto from "node:crypto";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import type {
  PitMetadata,
  WorktreeResult,
  SandboxMounts,
  OverlayMount,
  ParsedFlags,
} from "./types.ts";

// ── id generation ─────────────────────────────────────────────────────────────

/** Generate an 8-hex-character random id for worktrees and sessions. */
export function genId(): string {
  return crypto.randomBytes(4).toString("hex");
}

// ── metadata builders ─────────────────────────────────────────────────────────

/**
 * Build a no-tree PitMetadata struct.
 * Callers supply `id` and `created` so the IO boundary (genId, new Date) stays
 * outside this function.
 */
export function buildNoTreeMeta(
  cwd: string,
  repo: string,
  reason: PitMetadata["noTreeReason"],
  id: string,
  created: string,
): PitMetadata {
  return { id, repo, created, worktree: cwd, branch: "", mode: "no-tree", noTreeReason: reason };
}

/**
 * Build a worktree PitMetadata struct.
 * Derives the worktree path and branch name from repo + id.
 * Callers supply `id` and `created` so the IO boundary stays outside.
 */
export function buildWorktreeMeta(repo: string, id: string, created: string): PitMetadata {
  return {
    id,
    repo,
    created,
    worktree: path.join(path.dirname(repo), `${path.basename(repo)}-wt-${id}`),
    branch: `pi/${id}`,
    mode: "worktree",
  };
}

// ── sandbox announcement ──────────────────────────────────────────────────────

/**
 * Build the sandbox section of the session announcement from the mount lists.
 * Entries are grouped by label (or path when no label), preserving order
 * and deduplicating repeated labels (e.g. several extension paths → one entry).
 */
export function formatSandboxNote(mounts: SandboxMounts): string {
  const dedup = (items: Array<{ path: string; label?: string }>) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of items) {
      const key = m.label ?? m.path;
      if (!seen.has(key)) { seen.add(key); out.push(`\`${key}\``); }
    }
    return out.join(", ");
  };
  const overlays = mounts.overlay ?? [];
  const overlayLine = overlays.length > 0
    ? `\n- Ephemeral overlay (reads from parent, writes vanish on exit): ${dedup(overlays.map((m) => ({ path: m.dest, label: m.label })))}`
    : "";
  return `**Sandbox (bwrap):** This session runs inside an OS-level namespace (bubblewrap). Filesystem access is allowlist-based:
- Read-write: ${dedup(mounts.rw)}
- Read-only: ${dedup(mounts.ro)}${overlayLine}
- No access: anything outside the mounts listed above`;
}

/**
 * Build the mode announcement shown to the agent at session start.
 * Pure — output depends only on the worktree result and sandbox mounts.
 */
export function buildAnnouncement(meta: PitMetadata, sandboxMounts?: SandboxMounts): string {
  const sandboxSection = sandboxMounts ? `\n\n${formatSandboxNote(sandboxMounts)}` : "";
  if (meta.mode === "worktree") {
    return `**pit — worktree mode**
branch: \`${meta.branch}\`   worktree: \`${meta.worktree}\`

**Worktree:** You are working in an isolated git worktree on branch \`${meta.branch}\`, not on the main branch. Your changes stay here until the user reviews and merges them. The main working tree is untouched.${sandboxSection}`;
  }
  if (meta.noTreeReason === "linked-worktree") {
    return `**pit — no-tree mode** *(already inside a git worktree)*
Running directly in this git worktree — no new worktree was created.

No additional git isolation. Changes affect this worktree directly.${sandboxSection}`;
  }
  if (meta.noTreeReason === "forced") {
    return `**pit — no-tree mode** *(worktree creation skipped)*
Running in current directory — git worktree creation was skipped (\`-nt\`/\`--no-tree\`).

No git isolation. Changes affect the current directory directly.${sandboxSection}`;
  }
  return `**pit — no-tree mode**
Not inside a git repository — running in current directory without a worktree.

No git isolation. Changes affect the current directory directly.${sandboxSection}`;
}

// ── sandbox mount spec ────────────────────────────────────────────────────────

/**
 * Build the canonical SandboxMounts struct from pre-resolved inputs.
 *
 * All IO (resolveMainRepo, resolveUnversionedDirs, fs.statSync,
 * resolveWorktreeGitRwMounts, fs.realpathSync) must be done by the caller
 * before calling this function. This keeps the mount-list assembly pure and
 * directly testable without touching the filesystem.
 *
 * agentDirReal must be the symlink-resolved path so the rw --bind override
 * beats the ro home mount correctly inside bwrap.
 */
export function buildSandboxMountSpec(params: {
  home: string;
  cwd: string;
  agentDirReal: string;
  extensionMounts: string[];
  nodeDir: string;
  gitRwMounts: Array<{ path: string; label?: string }>;
  overlayDirs: OverlayMount[];
}): SandboxMounts {
  const { home, cwd, agentDirReal, extensionMounts, nodeDir, gitRwMounts, overlayDirs } = params;
  return {
    ro: [
      // home (ro base — covers mise installs, ~/.cache/ms-playwright, etc.)
      { path: home, label: "home directory" },
      // system dirs
      { path: "/usr",     label: "system dirs" },
      { path: "/etc",     label: "system dirs" },
      // /etc/resolv.conf → /mnt/wsl/resolv.conf on WSL; without this mount
      // the symlink dangles inside the sandbox and DNS fails with EAI_AGAIN.
      { path: "/mnt/wsl", label: "system dirs", optional: true },
      { path: "/lib",     label: "system dirs", optional: true },
      { path: "/lib64",   label: "system dirs", optional: true },
      { path: "/bin",     label: "system dirs", optional: true },
      { path: "/sbin",    label: "system dirs", optional: true },
      // Pi extensions and their node_modules
      ...extensionMounts.map((p) => ({ path: p, label: "Pi extensions" })),
    ],
    rw: [
      // git access scoped to this worktree's branch (no-op for non-worktree sessions)
      ...gitRwMounts,
      // worktree directory and pi config
      { path: cwd },
      { path: agentDirReal,                               label: "Pi config dir" },
      // npm cache + global node_modules (needed for `pi install` inside a session)
      { path: path.join(home, ".npm"),                    label: "npm cache" },
      { path: path.join(home, ".local/share/mise/shims"), label: "mise shims" },
      { path: path.join(nodeDir, "lib/node_modules"),     label: "Node.js global modules" },
      { path: path.join(nodeDir, "bin"),                  label: "Node.js bin" },
    ],
    overlay: overlayDirs,
  };
}

// ── session content builder ───────────────────────────────────────────────────

/**
 * Build the JSONL content for a new session file.
 *
 * Produces three newline-delimited JSON lines: a session header, a pit
 * CustomEntry carrying the worktree metadata, and a visible CustomMessageEntry
 * (TUI banner). The caller supplies sessionId and isoTs so the IO boundary
 * (crypto.randomUUID, new Date) stays in setupNewSession.
 */
export function buildSessionLines(
  result: WorktreeResult,
  sessionId: string,
  isoTs: string,
  sandboxMounts?: SandboxMounts,
): string {
  const id1 = crypto.randomBytes(4).toString("hex");
  const id2 = crypto.randomBytes(4).toString("hex");
  const { meta } = result;
  return [
    { type: "session", version: CURRENT_SESSION_VERSION, id: sessionId, timestamp: isoTs, cwd: result.cwd },
    { type: "custom", id: id1, parentId: null, timestamp: isoTs, customType: "pit", data: meta },
    { type: "custom_message", id: id2, parentId: id1, timestamp: isoTs, customType: "pit", content: buildAnnouncement(meta, sandboxMounts), display: true },
  ]
    .map((o) => JSON.stringify(o))
    .join("\n") + "\n";
}

// ── flag parsing ──────────────────────────────────────────────────────────────

/**
 * Strip pit-only flags from argv, returning the remainder for pi passthrough.
 */
export function parseFlags(argv: string[]): ParsedFlags {
  let sandbox = true;
  let noTree = false;
  const filteredArgv: string[] = [];
  for (const arg of argv) {
    if (arg === "--no-sandbox") sandbox = false;
    else if (arg === "-nt" || arg === "--no-tree") noTree = true;
    else filteredArgv.push(arg);
  }
  return { sandbox, noTree, filteredArgv };
}

// ── bucket naming ─────────────────────────────────────────────────────────────

/**
 * Derive the session bucket directory name for a cwd path.
 * Matches pi's internal naming: strip leading slash, replace separators
 * with dashes, wrap with "--".
 */
export function cwdToBucket(cwd: string): string {
  return "--" + cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
}

// ── settings filtering ────────────────────────────────────────────────────────

/**
 * Filter a settings object by removing denied packages.
 * Pure — returns a new object, never mutates the original.
 */
export function applyDenylist(
  settings: Record<string, unknown>,
  denyPackages: string[],
): Record<string, unknown> {
  if (denyPackages.length === 0) return settings;
  const deny = new Set(denyPackages);
  return {
    ...settings,
    packages: ((settings.packages as string[] | undefined) ?? []).filter(
      (p) => !deny.has(p)
    ),
  };
}

// ── pi args helpers ───────────────────────────────────────────────────────────

/**
 * Build the --append-system-prompt args to pass to pi on every launch.
 * Gives the model current pit mode and sandbox state without touching the
 * session file tree.
 */
export function systemPromptArgs(meta: PitMetadata, sandboxMounts: SandboxMounts | undefined): string[] {
  return ["--append-system-prompt", buildAnnouncement(meta, sandboxMounts)];
}
