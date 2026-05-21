/**
 * Pure sandbox logic — builds bwrap mount specs and filters settings.
 * No filesystem, no process spawning.
 */

import { join } from "node:path";
import type { SandboxMounts, OverlayMount } from "../types.ts";

// ── sandbox announcement ──────────────────────────────────────────────────────

/**
 * Build the sandbox section of the session announcement from the mount lists.
 * Entries are grouped by label (or path when no label), deduplicating repeated
 * labels (e.g. several extension paths all labelled "Pi extensions" → one entry).
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

// ── mount spec builder ────────────────────────────────────────────────────────

/**
 * Build the canonical SandboxMounts struct from pre-resolved inputs.
 * All IO (resolveMainRepo, resolveUnversionedDirs, fs.statSync,
 * resolveWorktreeGitRwMounts) must be done by the caller before calling this.
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
      { path: home, label: "home directory" },
      { path: "/usr",     label: "system dirs" },
      { path: "/etc",     label: "system dirs" },
      { path: "/mnt/wsl", label: "system dirs", optional: true },
      { path: "/lib",     label: "system dirs", optional: true },
      { path: "/lib64",   label: "system dirs", optional: true },
      { path: "/bin",     label: "system dirs", optional: true },
      { path: "/sbin",    label: "system dirs", optional: true },
      ...extensionMounts.map((p) => ({ path: p, label: "Pi extensions" })),
    ],
    rw: [
      ...gitRwMounts,
      { path: cwd },
      { path: agentDirReal,                               label: "Pi config dir" },
      { path: join(home, ".npm"),                    label: "npm cache" },
      { path: join(home, ".local/share/mise/shims"), label: "mise shims" },
      { path: join(nodeDir, "lib/node_modules"),     label: "Node.js global modules" },
      { path: join(nodeDir, "bin"),                  label: "Node.js bin" },
    ],
    overlay: overlayDirs,
  };
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
    packages: ((settings.packages as string[] | undefined) ?? []).filter((p) => !deny.has(p)),
  };
}
