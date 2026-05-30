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
 * Behaviour is driven by the read policy encoded in `mounts`:
 *   readDeny === undefined  → whitelist mode (Linux/bwrap):
 *     reads are closed by default; ro[] lists what is readable.
 *   readDeny !== undefined  → blacklist mode (macOS/sandbox-exec):
 *     reads are globally open; readDeny[] lists what is blocked.
 *
 * Entries are grouped by label (or path when no label), deduplicating
 * repeated labels (e.g. several extension paths all labelled "Pi extensions").
 */
export const formatSandboxNote = (mounts: Readonly<SandboxMounts>): string => {
  const dedup = (items: Array<{ path: string; label?: string }>) => {
    const keys = [...new Map(items.map(m => [m.label ?? m.path, true])).keys()];
    return keys.map(key => `\`${key}\``).join(", ");
  };

  const backend = mounts.backend ?? 'bwrap';
  const blacklist = mounts.readDeny !== undefined;

  const rwLine = `- Read-write: ${dedup(mounts.rw)}`;

  if (blacklist) {
    const denied = mounts.readDeny ?? [];
    const readLine = denied.length > 0
      ? `- Reads unrestricted except: ${dedup(denied)}`
      : `- Reads unrestricted`;
    return `**Sandbox (${backend}):** This session runs inside a macOS policy sandbox. Filesystem access:
${rwLine}
${readLine}
- No write access: anything outside the listed paths above`;
  }

  const overlays = mounts.overlay ?? [];
  const overlayLine = overlays.length > 0
    ? `\n- Ephemeral overlay (reads from parent, writes vanish on exit): ${dedup(overlays.map((m) => ({ path: m.dest, label: m.label })))}`
    : "";
  return `**Sandbox (${backend}):** This session runs inside an OS-level namespace (bubblewrap). Filesystem access is allowlist-based:
${rwLine}
- Read-only: ${dedup(mounts.ro)}${overlayLine}
- No access: anything outside the mounts listed above`;
};

// ── env whitelist ────────────────────────────────────────────────────────────

/**
 * Build --setenv pairs for each name in config.allowEnv that is present in env.
 * Used by bwrapLaunch. Pure — no IO, no side effects.
 */
export const allowedEnvArgs = (
  config: Readonly<PitConfig>,
  env: Readonly<Record<string, string | undefined>>,
): string[] =>
  (config.allowEnv ?? []).flatMap((name) =>
    env[name] !== undefined ? ["--setenv", name, env[name]!] : [],
  );

/**
 * Build a filtered env Record for the macOS sandbox-exec spawn call.
 * Includes built-in defaults plus any names from config.allowEnv.
 * Pure — no IO, no side effects.
 */
export const buildSealedEnv = (
  config: Readonly<PitConfig>,
  env: Readonly<Record<string, string | undefined>>,
  nodeDir: string,
): Record<string, string> => {
  const builtins = [
    "HOME", "TERM", "LANG",
    "http_proxy", "https_proxy", "no_proxy",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
    "PIT_ESCAPE_SOCKET", "PIT_ESCAPE_TOKEN",
    "PIT_IS_INNER", "PI_CODING_AGENT",
    "PI_CODING_AGENT_DIR", "PI_SKIP_VERSION_CHECK",
  ];
  const extra = config.allowEnv ?? [];
  const base: Record<string, string> = {
    // PATH must include Homebrew (Apple Silicon /opt/homebrew, Intel /usr/local)
    // so the agent can find git, node, and any Homebrew-installed tool.
    PATH: `${nodeDir}/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    PI_CODING_AGENT: "true",
    PIT_IS_INNER: "1",
  };
  return [...builtins, ...extra].reduce<Record<string, string>>((acc, name) =>
    env[name] !== undefined ? { ...acc, [name]: env[name]! } : acc,
    base,
  );
};

// ── mount spec builder ────────────────────────────────────────────────────────

const MACOS_DEFAULT_READ_DENY: Array<{ label: string; segments: string[] }> = [
  { label: "~/.ssh",           segments: [".ssh"] },
  { label: "~/.aws",           segments: [".aws"] },
  { label: "~/.gnupg",         segments: [".gnupg"] },
  { label: "~/.config/gh",     segments: [".config", "gh"] },
  { label: "~/.config/gcloud", segments: [".config", "gcloud"] },
  { label: "~/.azure",         segments: [".azure"] },
  { label: "~/.config/op",     segments: [".config", "op"] },
  { label: "~/.netrc",         segments: [".netrc"] },
];

/**
 * Build the canonical SandboxMounts struct from pre-resolved inputs.
 * All IO (resolveMainRepo, resolveUnversionedDirs, fs.statSync,
 * resolveWorktreeGitRwMounts) must be done by the caller before calling this.
 *
 * platform: 'linux'  → bwrap model: ro[] drives read grants, no readDeny
 * platform: 'darwin' → sandbox-exec model: ro[] is annotation-only, readDeny set
 */
export const buildSandboxMountSpec = (params: Readonly<{
  home: string;
  cwd: string;
  agentDir: string;
  agentDirReal: string;
  extensionMounts: string[];
  nodeDir: string;
  gitRwMounts: Array<{ path: string; label?: string }>;
  overlayDirs: OverlayMount[];
  platform?: 'linux' | 'darwin';
  pitConfig?: Readonly<PitConfig>;
}>): SandboxMounts => {
  const {
    home, cwd, agentDir, agentDirReal, extensionMounts,
    nodeDir, gitRwMounts, overlayDirs,
    platform = 'linux',
    pitConfig,
  } = params;

  const ro: RoMount[] = [
    { path: join(home, ".gitconfig"),                          label: "home dotfiles", optional: true },
    { path: join(home, ".config", "git"),                      label: "home dotfiles", optional: true },
    { path: join(home, ".npmrc"),                              label: "home dotfiles", optional: true },
    { path: join(home, ".local", "share", "mise", "installs"), label: "home dotfiles", optional: true },
    ...(platform === 'linux'
      ? [
          { path: "/usr",     label: "system dirs" },
          { path: "/etc",     label: "system dirs" },
          { path: "/mnt/wsl", label: "system dirs", optional: true },
          // Ubuntu 24.04+: /etc/resolv.conf → /run/systemd/resolve/stub-resolv.conf.
          // Without this mount the symlink is dangling inside bwrap and all DNS fails.
          { path: "/run/systemd/resolve", label: "system dirs", optional: true },
          { path: "/lib",     label: "system dirs", optional: true },
          { path: "/lib64",   label: "system dirs", optional: true },
          { path: "/bin",     label: "system dirs", optional: true },
          { path: "/sbin",    label: "system dirs", optional: true },
        ]
      : [
          { path: "/usr",     label: "system dirs" },
          { path: "/private/etc", label: "system dirs" },
          { path: "/Library",     label: "system dirs", optional: true },
        ]
    ),
    ...extensionMounts.map((p) => ({ path: p, label: "Pi extensions" })),
  ];

  const rw = [
    ...gitRwMounts,
    { path: cwd },
    { path: agentDirReal,                               label: "Pi config dir" },
    ...(agentDir !== agentDirReal ? [{ path: agentDir, label: "Pi config dir (symlink)" }] : []),
    { path: join(home, ".npm"),                    label: "npm cache",   optional: true as const },
    { path: join(home, ".local/share/mise/shims"), label: "mise shims", optional: true as const },
    { path: join(nodeDir, "lib/node_modules"),     label: "Node.js global modules" },
    { path: join(nodeDir, "bin"),                  label: "Node.js bin" },
    ...(pitConfig?.sandbox?.allowWrite ?? []).map(p => ({ path: p, label: "user write grant" })),
  ];

  if (platform === 'linux') {
    return {
      ro, rw,
      overlay: overlayDirs,
      backend: 'bwrap',
    };
  }

  // macOS: blacklist read model
  const userDenyRead = (pitConfig?.sandbox?.denyRead ?? []).map(p => ({ path: p }));
  const userAllowRead = new Set(pitConfig?.sandbox?.allowRead ?? []);

  const defaultDeny: RoMount[] = MACOS_DEFAULT_READ_DENY
    .filter(({ segments }) => !userAllowRead.has(join(home, ...segments)))
    .map(({ label, segments }) => ({ path: join(home, ...segments), label }));

  return {
    ro, rw,
    readDeny: [...defaultDeny, ...userDenyRead],
    backend: 'sandbox-exec',
  };
};

// ── settings filtering ────────────────────────────────────────────────────────

/**
 * Filter a settings object by removing denied packages.
 * Pure — returns a new object, never mutates the original.
 */
export const applyDenylist = (
  settings: Record<string, unknown>,
  denyPackages: string[],
): Record<string, unknown> => {
  if (denyPackages.length === 0) return settings;
  const deny = new Set(denyPackages);
  return {
    ...settings,
    packages: ((settings.packages as string[] | undefined) ?? []).filter((p) => !deny.has(p)),
  };
};
