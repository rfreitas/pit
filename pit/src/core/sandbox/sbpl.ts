/**
 * SBPL profile builder for macOS sandbox-exec.
 * Pure — no filesystem access, no process spawning.
 *
 * Callers must resolve all paths to their real (symlink-free) forms before
 * passing SandboxMounts, since SBPL matches on real paths.
 *
 * Profile model (confirmed by @anthropic-ai/sandbox-runtime + @nqbao/pi-sandbox
 * and validated by pit/debug/sbpl-probe.test.ts on macos-14):
 *   (deny default)
 *   (allow file-read*)          — reads are globally open (macOS blacklist model)
 *   write grants from rw[]
 *   read denials from readDeny[]
 *   fixed mach/IPC/sysctl/device requirements for Node.js
 */

import type { SandboxMounts } from "../../types.ts";

// ── mach service lists ────────────────────────────────────────────────────────
// Derived from @anthropic-ai/sandbox-runtime (Claude Code production sandbox)
// and @nqbao/pi-sandbox. Validated on GitHub Actions macos-14 (Apple Silicon).
// Trim only with empirical testing — a missing entry causes a silent hang.

const NODE_MACH_SERVICES = [
  "com.apple.logd",
  "com.apple.system.logger",
  "com.apple.system.opendirectoryd.libinfo",
  "com.apple.system.opendirectoryd.membership",
  "com.apple.bsd.dirhelper",
  "com.apple.securityd.xpc",
  "com.apple.coreservices.launchservicesd",
  "com.apple.FontObjectsServer",
  "com.apple.fonts",
  "com.apple.lsd.mapdb",
  "com.apple.PowerManagement.control",
  "com.apple.system.notification_center",
  "com.apple.SecurityServer",
  "com.apple.cfprefsd.daemon",
  "com.apple.cfprefsd.agent",
  "com.apple.audio.systemsoundserver",
  "com.apple.distributed_notifications@Uv3",
] as const;

const NETWORK_MACH_SERVICES = [
  "com.apple.mDNSResponder",
  "com.apple.mDNSResponderHelper",
  "com.apple.trustd.agent",   // TLS cert verification
] as const;

// ── profile builder ───────────────────────────────────────────────────────────

const esc = (p: string): string => JSON.stringify(p);

/**
 * Generate an SBPL profile string for `sandbox-exec -p <profile>`.
 *
 * The `mounts` struct must have `backend === 'sandbox-exec'` and real
 * (symlink-resolved) paths. Network access is always allowed — restricting
 * it requires an HTTP proxy approach (see security.md).
 */
export const buildSbplProfile = (mounts: Readonly<SandboxMounts>): string => {
  const header = [
    "(version 1)",
    "(deny default)",
    "",
    "; reads are globally open — macOS sandbox model (see plans/mac-sandbox.md)",
    "(allow file-read*)",
    "",
    "; process",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow process-info* (target same-sandbox))",
    "(allow signal (target same-sandbox))",
    "(allow signal (target children))",
    "",
    "; mach IPC for Node.js — validated on macos-14, see plans/mac-sandbox.md Grill 8",
    "(allow mach-lookup",
    ...[...NODE_MACH_SERVICES, ...NETWORK_MACH_SERVICES].map(s => `  (global-name ${esc(s)})`),
    ")",
    "",
    "; POSIX IPC (V8 shared memory, semaphores)",
    "(allow ipc-posix-shm)",
    "(allow ipc-posix-sem)",
    "",
    "; sysctl",
    "(allow sysctl-read)",
    `(allow sysctl-write (sysctl-name "kern.tcsm_enable"))`,
    "",
    "; user preferences + notifications",
    "(allow user-preference-read)",
    "(allow distributed-notification-post)",
    "",
    "; IOKit",
    "(allow iokit-open",
    `  (iokit-registry-entry-class "IOSurfaceRootUserClient")`,
    `  (iokit-registry-entry-class "RootDomainUserClient")`,
    `  (iokit-user-client-class "IOSurfaceSendRight"))`,
    "(allow iokit-get-properties)",
    "",
    "; safe system socket",
    "(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))",
    "",
    "; TTY and device nodes",
    "; /dev/null and /dev/tty need file-read*/file-write* (not just ioctl):",
    "; git and many subprocesses open /dev/null for r+w on startup.",
    "(allow pseudo-tty)",
    `(allow file-read* file-write* (literal "/dev/ptmx"))`,
    `(allow file-read* file-write* (regex #"^/dev/ttys"))`,
    `(allow file-ioctl (literal "/dev/null") (literal "/dev/tty") (literal "/dev/ptmx"))`,
    `(allow file-read* file-write* (literal "/dev/null"))`,
    `(allow file-read* file-write* (literal "/dev/tty"))`,
    "",
    "; /private/tmp always writable (mirror dir, temp scripts, temp settings)",
    `(allow file-write* (subpath "/private/tmp"))`,
    "",
  ];

  const writeSection = mounts.rw.length > 0
    ? [
        "; write grants",
        "(allow file-write*",
        ...mounts.rw.map(m => `  (subpath ${esc(m.path)})`),
        ")",
        "",
      ]
    : [];

  const denied = mounts.readDeny;
  const denySection = denied.length > 0
    ? [
        "; read denylist — credential and sensitive paths",
        ...denied.map(m => `(deny file-read* (subpath ${esc(m.path)}))`),
        "",
      ]
    : [];

  const network = [
    "; network — always open (restriction via proxy is future work)",
    "(allow network*)",
    "(allow system-socket (socket-domain AF_UNIX))",
    `(allow network-outbound (remote unix-socket (path-regex #"^/")))`,
    `(allow network-inbound  (local  ip "*:*"))`,
  ];

  return [...header, ...writeSection, ...denySection, ...network].join("\n");
};
