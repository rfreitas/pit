/**
 * Pure sandbox logic — builds bwrap/sbpl mount specs and filters settings.
 * No filesystem, no process spawning.
 */

import { join } from "node:path";
import type { SandboxMounts, OverlayMount, PitConfig, RoMount } from "../../types.ts";

// ── sandbox announcement ──────────────────────────────────────────────────────

/**
 * Build the sandbox section of the session announcement from the mount lists.
 *
 * Both platforms now use the same denylist model:
 *   - readDeny[] lists paths that are blocked from reading
 *   - rw[] lists paths with write access
 *   - Everything else is read-only
 *
 * Entries are grouped by label (or path when no label), deduplicating
 * repeated labels.
 */
export const formatSandboxNote = (mounts: Readonly<SandboxMounts>): string => {
  const dedup = (items: Array<{ path: string; label?: string }>) => {
    const keys = [...new Map(items.map(m => [m.label ?? m.path, true])).keys()];
    return keys.map(key => `\`${key}\``).join(", ");
  };

  const backend = mounts.backend ?? 'bwrap';
  const rwLine = `- Read-write: ${dedup(mounts.rw)}`;
  const denied = mounts.readDeny;
  const readLine = denied.length > 0
    ? `- Reads unrestricted except: ${dedup(denied)}`
    : `- Reads unrestricted`;
  
  const overlays = mounts.overlay ?? [];
  const overlayLine = overlays.length > 0
    ? `\n- Ephemeral overlay (reads from parent, writes vanish on exit): ${dedup(overlays.map((m) => ({ path: m.dest, label: m.label })))}`
    : "";
  
  return `**Sandbox (${backend}):** This session runs inside an OS-level sandbox. Filesystem access:
${rwLine}
${readLine}${overlayLine}
- No write access: anything outside the listed paths above`;
};

// ── env whitelist ────────────────────────────────────────────────────────────

/**
 * Build a unified environment for sandboxed child processes.
 * Used by both bwrap (as --setenv args) and sandbox-exec (as spawn env).
 *
 * Forwards PATH from host instead of constructing platform-specific paths.
 * This eliminates hardcoded /opt/homebrew paths and works with any package
 * manager (nix, asdf, mise, volta, etc.).
 *
 * Pure — no IO, no side effects.
 */
export const buildSandboxEnv = (
  config: Readonly<PitConfig>,
  env: Readonly<Record<string, string | undefined>>,
  escapeToken?: string,
): Record<string, string> => {
  const base: Record<string, string> = {
    PI_CODING_AGENT: "true",
    PIT_SANDBOXED: "1",
    ...(escapeToken ? { PIT_ESCAPE_TOKEN: escapeToken } : {}),
  };

  // Forward these from host env if present
  const forwardIfPresent = [
    "HOME", "PATH", "TERM", "LANG",
    "http_proxy", "https_proxy", "no_proxy",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
    "PIT_ESCAPE_SOCKET",
    "PI_CODING_AGENT_DIR", "PI_SKIP_VERSION_CHECK",
  ];

  const extra = config.allowEnv ?? [];

  return [...forwardIfPresent, ...extra].reduce<Record<string, string>>((acc, name) =>
    env[name] !== undefined ? { ...acc, [name]: env[name]! } : acc,
    base,
  );
};

// ── default permissions ──────────────────────────────────────────────────────

/**
 * Default sandbox permissions applied to both platforms.
 * Path templates: ~ (home), {cwd}, {agentDir}, {nodeDir}
 */
const DEFAULT_SANDBOX_PERMISSIONS = {
  readDeny: [
    { path: "~/.ssh", label: "credentials" },
    { path: "~/.aws", label: "credentials" },
    { path: "~/.gnupg", label: "credentials" },
    { path: "~/.config/gh", label: "credentials" },
    { path: "~/.config/gcloud", label: "credentials" },
    { path: "~/.azure", label: "credentials" },
    { path: "~/.config/op", label: "credentials" },
    { path: "~/.netrc", label: "credentials" },
  ],
  writeAllow: [
    { path: "{cwd}", label: "worktree" },
    { path: "/tmp", label: "temp dir" },
    { path: "{agentDir}", label: "Pi config dir" },
    { path: "~/.npm", label: "npm cache", optional: true },
    { path: "~/.local/share/mise/shims", label: "mise shims", optional: true },
    { path: "{nodeDir}/lib/node_modules", label: "Node.js global modules" },
    { path: "{nodeDir}/bin", label: "Node.js bin" },
  ],
} as const;

/**
 * Build the canonical SandboxMounts struct from pre-resolved inputs.
 * All IO (resolveMainRepo, resolveUnversionedDirs, fs.statSync,
 * resolveWorktreeGitRwMounts) must be done by the caller before calling this.
 *
 * Both platforms now use the same denylist model:
 * - readDeny[] lists paths to block from reading
 * - rw[] lists paths with write access
 * - Everything else is read-only
 */
export const buildSandboxMountSpec = (params: Readonly<{
  home: string;
  cwd: string;
  agentDir: string;
  nodeDir: string;
  gitRwMounts: Array<{ path: string; label?: string }>;
  overlayDirs: OverlayMount[];
  pitConfig?: Readonly<PitConfig>;
}>): SandboxMounts => {
  const { home, cwd, agentDir, nodeDir, gitRwMounts, overlayDirs, pitConfig } = params;

  // Resolve path templates
  const resolve = (p: string): string =>
    p.startsWith("~") ? join(home, p.slice(2))
    : p.replace("{cwd}", cwd)
       .replace("{agentDir}", agentDir)
       .replace("{nodeDir}", nodeDir);

  // Build read deny list (defaults + user config)
  const userDeny = (pitConfig?.sandbox?.denyRead ?? []).map(p => ({ path: p, label: "user deny" }));
  const readDeny = [
    ...DEFAULT_SANDBOX_PERMISSIONS.readDeny.map(m => ({ ...m, path: resolve(m.path) })),
    ...userDeny.map(m => ({ ...m, path: resolve(m.path) })),
  ];

  // Build write allow list (git mounts + defaults + user config)
  const userWrite = (pitConfig?.sandbox?.allowWrite ?? []).map(p => ({ path: p, label: "user write grant" }));
  const rw = [
    ...gitRwMounts,
    ...DEFAULT_SANDBOX_PERMISSIONS.writeAllow.map(m => ({ ...m, path: resolve(m.path) })),
    ...userWrite.map(m => ({ ...m, path: resolve(m.path) })),
  ];

  return {
    rw,
    readDeny,
    overlay: overlayDirs,
  };
};


/**
 * Build --extension flags from pit config's nonSandboxExtensions.
 * Returns empty array when undefined or empty — safe to spread into piArgs.
 */
export const nonSandboxExtensionFlags = (
  pitConfig: Readonly<PitConfig> | undefined,
): string[] =>
  pitConfig?.nonSandboxExtensions?.flatMap(p => ["--extension", p]) ?? [];
