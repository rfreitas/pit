# macOS Sandbox Implementation Plan

## What bwrap actually does (Linux side)

`bwrapLaunch` creates a **Linux kernel namespace** via `clone(CLONE_NEWUSER | CLONE_NEWNS | CLONE_NEWPID)`. Inside that namespace:

| bwrap flag | Kernel mechanism | Purpose |
|---|---|---|
| `--tmpfs /` | Mount namespace + tmpfs | Closed filesystem: empty root, nothing visible unless granted |
| `--ro-bind P P` | Bind mount (read-only) | Read grants: selective read-only paths |
| `--bind P P` | Bind mount (read-write) | Write grants: selective read-write paths |
| `--overlay-src L --tmp-overlay D` | overlayfs (kernel) | Ephemeral layers: lower=L on host, upper=tmpfs; writes discarded on exit |
| `--bind A /pit-agent` + `--bind F /pit-agent/settings.json` | Two bind mounts, second wins | Dir remap + package filtering: config dir at controlled path, settings.json replaced |
| `--unshare-user` | CLONE_NEWUSER | Identity isolation: UID 0 inside namespace without real root |
| `--unshare-pid` | CLONE_NEWPID | Process isolation: PID 1 inside namespace, orphans reaped |
| `--clearenv` + `--setenv` | execve env | Env seal: clean environment, explicit allowlist only |
| `--die-with-parent` | `prctl(PR_SET_PDEATHSIG, SIGKILL)` | Lifetime binding: sandbox killed when pit exits |
| `--chdir D` | `chdir` after namespace setup | Start process in correct working directory |

---

## macOS: what exists

macOS does not have Linux namespaces. The available primitives are:

### `sandbox-exec` / Seatbelt (SBPL)

`/usr/bin/sandbox-exec -p <profile> <cmd>` installs a MAC (Mandatory Access Control) policy via the TrustedBSD kernel hook (same mechanism Apple uses for App Sandbox). The profile is passed inline via `-p`; no temp file needed. The SBPL profile language is Scheme-like.

Both `@nqbao/pi-sandbox` and `@anthropic-ai/sandbox-runtime` (Anthropic's production sandbox for Claude Code) have been reviewed as reference implementations. Both use the same read model:

```scheme
(version 1)
(deny default)
(allow file-read*)          ; reads are globally open
(allow file-write*
  (subpath "/home/user/worktree")
  (subpath "/home/user/.pi/agent"))
(allow process-exec)
(allow process-fork)
; mach, sysctl, ipc-posix-shm, iokit — see profile notes below
```

Reads are **globally open**. This sidesteps dyld shared cache enumeration, Gatekeeper xattr reads, and all system path discovery. Only writes are controlled. This is the correct pattern for sandboxing arbitrary binaries on macOS.

This is **deny-based, not namespace-based**. The process sees the real filesystem layout but write ACCESS is controlled. There is no isolated mount table.

### APFS `clonefile` (CoW)

`cp -c -R src dst` on APFS creates a copy-on-write clone instantly (reflink). Reads are shared with source; writes to clone diverge. The clone is a real directory on the host filesystem — it does not vanish when the process exits.

### No direct equivalents exist for:

- Closed filesystem (mount namespaces) → **nothing on macOS without root**
- Ephemeral layers (overlayfs) → **nothing built-in** (would need macFUSE + overlayfs-fuse, a third-party kext)
- System path grants (`/proc`, `/dev` as Linux knows them) → N/A on macOS (XNU has `/dev`, no `/proc`)
- Lifetime binding (`prctl(PR_SET_PDEATHSIG)`) → macOS has `kqueue EVFILT_PROC/NOTE_EXIT`, requires explicit polling

---

## Feature-by-feature mapping

### 1. Closed filesystem (`--tmpfs /`)

**Linux**: empty tmpfs at `/`; nothing visible unless explicitly mounted in. Reads AND writes to unlisted paths are blocked.

**macOS**: no mount namespace equivalent. The production approach (confirmed by both reference implementations) is `(deny default)` + `(allow file-read*)`: reads are globally open, writes are restricted to an explicit allowlist. The agent can read any file on the filesystem — credentials, other projects, home directory. Only writes are controlled.

This is a **meaningful security downgrade** from the Linux model. On Linux the agent cannot exfiltrate `~/.ssh` or `~/.aws` by reading them. On macOS it can. The closed filesystem feature on macOS is better described as a **write-closed filesystem**.

**Plan**: Accept the read-open model — it is the only viable approach without requiring root. The `readDeny` field on `SandboxMounts` and the read-policy-driven `formatSandboxNote` ensure the sandbox announcement accurately describes this to the agent.

---

### 2. Read grants (`--ro-bind PATH PATH`)

**Linux**: bind mount with `MS_RDONLY`.

**macOS sandbox-exec equivalent**:
```scheme
(allow file-read* (subpath "/usr"))
(allow file-read* (subpath "/etc"))
```

**Plan**: `buildSandboxMountSpec` already produces `SandboxMounts.ro[]`. On macOS, read grants are redundant — `(allow file-read*)` covers everything. The ro[] list is still used to build the sandbox announcement (so the agent knows its nominal read scope) but does not drive SBPL rules.

---

### 3. Write grants (`--bind PATH PATH`)

**Linux**: bind mount, writable.

**macOS equivalent**:
```scheme
(allow file-read* (subpath "/home/user/worktree"))
(allow file-write* (subpath "/home/user/worktree"))
```

**Plan**: same iteration over `SandboxMounts.rw[]`, emit both `file-read*` and `file-write*` per entry.

---

### 4. Ephemeral layers (`--overlay-src SRC --tmp-overlay DEST`)

**Linux**: kernel overlayfs with tmpfs upper. Lower=parent dir, upper=tmpfs. Writes go to tmpfs, vanish on exit.

**macOS**: **no equivalent without third-party kernel extensions.**

**Plan A (APFS clone fallback)**:
- Before launch, `cp -c -R src dest` for each overlay dir. Creates an instant CoW clone on APFS.
- The clone is a real directory owned by the user.
- Register a cleanup handler: delete `dest` on process exit.
- Problem: if pit crashes, the clone is left behind. It's a real directory in the worktree, which may confuse git status.
- Mitigation: add a manifest file (e.g. `.pit-overlay-cleanup.json`) in the worktree tracking what to clean. On next pit startup, check and clean stale clones.

**Plan B (skip overlays on macOS)**:
- Emit a warning: `pit: overlay mounts not supported on macOS — unversioned dirs (node_modules etc.) not available in sandbox`
- The agent can still function; it just won't have the parent's node_modules visible at the worktree path.
- Simpler and safer default. Opt into APFS clone with a config flag.

The SBPL approach to overlays is not possible at all — sandbox-exec is purely access-control, it cannot change what a path resolves to.

---

### 5. Dir remap + package filtering (`--bind AGENTDIR /pit-agent` + `--bind FILTERED /pit-agent/settings.json`)

**Linux**: Two bind mounts at the virtual path `/pit-agent`. The second bind (on settings.json) wins because it's applied after. `PI_CODING_AGENT_DIR=/pit-agent` makes pi read filtered settings from the fake path while session writes go to the real agent dir via the underlying bind.

**macOS**: Cannot create `/pit-agent` as a new path without root. Cannot layer a file bind on top of a directory bind.

**Plan (symlink mirror)**:
1. Pre-create all known agentDir subdirs in the real agentDir before mirroring: `bin/`, `sessions/` (already created by pit), `themes/`, `prompts/`, `git/`. This ensures they exist at mirror time and are symlinked correctly.
2. `mkdtempSync('/private/tmp/pit-agent-XXXX')` — use `/private/tmp` explicitly, not `os.tmpdir()`, so the path is stable and narrow (see SBPL path notes below).
3. For each entry in the real `agentDir`, create a symlink: `/private/tmp/pit-agent-XXXX/sessions` → `/real/agent/sessions`, etc.
4. Write the filtered `settings.json` directly into the mirror as a real file (not a symlink).
5. Set `PI_CODING_AGENT_DIR=/private/tmp/pit-agent-XXXX`.
6. SBPL profile allows rw on `/private/tmp/pit-agent-XXXX/` and on the real `agentDir` (so symlink targets are accessible).
7. On exit, delete the mirror dir.

Writes to `sessions/` follow the symlink → go to real agent dir. Writes to `settings.json` go to the temp file. The guarantee is preserved.

Subdirectory gap: Pi calls `ensureTool("fd")` and `ensureTool("rg")` at every interactive session startup, creating `agentDir/bin/` via `mkdirSync` if it doesn't exist. Step 1 covers this. Unknown subdirs added in future SDK versions remain a risk — they'd be created in the mirror, not the real agentDir, and lost on exit. Impact is low (tools re-downloaded, not data loss).

---

### 6. Env seal (`--clearenv` + `--setenv`)

**Linux**: bwrap clears the environment and passes only specified vars.

**macOS**: `sandbox-exec` does NOT control the environment. It just runs the command with the current environment.

**Plan**: Pass `{ env: filteredEnv }` to `spawnSync` — the same call used for bwrap on Linux. `spawnSync` accepts `options.env` identically to `spawn`. This keeps `sbplLaunch` returning `never` (same shape as `bwrapLaunch`) and handles env seal cleanly. The `allowedEnvArgs` logic in `pure.ts` can be reused — just populate an object instead of building `--setenv` pairs.

---

### 7. Identity isolation (`--unshare-user`)

**Linux**: Unprivileged user gets UID 0 inside namespace. Needed for bwrap to mount things without real root.

**macOS**: Not applicable. sandbox-exec runs the process as the same user. No UID mapping. `sandbox-exec` itself requires no elevated privileges for the caller.

**Plan**: No equivalent needed. sandbox-exec's MAC policy is the isolation mechanism; no UID change is needed or available.

---

### 8. Process isolation (`--unshare-pid`)

**Linux**: PID namespace. Child is PID 1 inside; orphaned children are reaped automatically. Prevents PID-based attacks.

**macOS**: No equivalent. The process has a normal macOS PID.

**Plan**: Skip. Not a security regression from current macOS baseline (there was no sandbox before).

---

### 9. Lifetime binding (`--die-with-parent`)

**Linux**: Child is killed when parent exits. Ensures the sandbox dies if pit dies.

**macOS**: `kqueue` with `EVFILT_PROC / NOTE_EXIT` can watch a PID and send a signal when it exits, but requires the child to set it up itself, or a wrapper process to relay.

**Plan**: Use `spawn` with `detached: false` (the default) — when the parent `pit.ts` exits, the child receives SIGHUP if the terminal closes. Additionally, set up `process.on('exit', () => child.kill())` in the parent (already done for pit-escape). Does not cover hard SIGKILL of pit, but acceptable for now.

---

### 10. Network policy

Currently the network namespace is NOT isolated even on Linux (see security.md). The agent needs outbound internet for AI APIs.

**macOS**: add `(allow network-outbound)` and `(allow network-inbound)` (needed for the pit-escape socket). This matches the current Linux behaviour exactly.

---

### 11. System path grants (`/dev`, `/proc`)

**Linux**: `--dev /dev --proc /proc` creates device nodes and the proc filesystem.

**macOS**: `/dev` already exists as part of the real filesystem. `/proc` doesn't exist on macOS.

**Plan**: Add `(allow file-read* (subpath "/dev"))` to the profile. No `/proc` mount needed.

---

## Type changes

### `SandboxMounts`

`readDeny` is added as the read-policy discriminator. Its presence (vs `undefined`) signals which mode the formatter and the SBPL builder operate in:

```ts
interface SandboxMounts {
  ro: RoMount[]        // whitelist mode: drives ro-bind on Linux; announcement-only on macOS
  rw: RwMount[]        // both modes: drives bind on Linux, file-write* allow on macOS
  readDeny?: RoMount[] // undefined  → whitelist mode (Linux)
                       // []         → blacklist mode, reads fully open (macOS, no denials)
                       // [...]      → blacklist mode, reads open except listed (macOS default)
  overlay?: OverlayMount[]
}
```

`buildSandboxMountSpec` gains a `platform: 'linux' | 'darwin'` parameter:
- Linux: populates `ro[]` as today, `readDeny` left `undefined`
- macOS: populates `ro[]` for announcement purposes only, `readDeny` set to the default credential denylist

### Default macOS `readDeny`

Paths blocked from agent reads by default on macOS:

```
~/.ssh           private keys
~/.aws           AWS credentials
~/.gnupg         GPG private keys
~/.config/gh     GitHub CLI token
~/.config/gcloud GCP credentials
~/.azure         Azure credentials
~/.config/op     1Password CLI session
~/.netrc         network credentials
```

User can extend or override via config (see Config section below).

---

## `formatSandboxNote` redesign

The formatter becomes read-policy-driven, not platform-driven. It reads `mounts.readDeny` to determine the mode. The backend name (bwrap vs sandbox-exec) is passed as a separate parameter since it is enforcement infrastructure, not policy data:

```ts
formatSandboxNote(mounts: SandboxMounts, backend: 'bwrap' | 'sandbox-exec'): string
```

Behaviour:

```
readDeny === undefined  →  whitelist mode:
  header:  "Sandbox (bwrap): ... allowlist-based"
  section: "Read-only: <ro[] labels>"
  footer:  "No access: anything outside the mounts listed above"

readDeny !== undefined  →  blacklist mode:
  header:  "Sandbox (sandbox-exec): ... write-restricted"
  section: "Reads unrestricted except: <readDeny[] labels>"  (omitted if readDeny is [])
  footer:  "No write access: anything outside the listed paths above"
```

This resolves Grill 7 structurally: the formatter has the correct data to describe the actual policy on both platforms without branching on platform identity.

---

## Config

`~/.pi/pit/config.json` gains a `sandbox` object for user-controlled read/write policy adjustments:

```json
{
  "denyPackages": [],
  "allowEnv": [],
  "sandbox": {
    "allowRead": [],
    "denyRead": [],
    "allowWrite": []
  }
}
```

| Field | Linux behaviour | macOS behaviour |
|---|---|---|
| `allowRead` | Adds paths to the read allowlist (`ro[]`) | Carves exceptions out of the read denylist — paths listed here are removed from `readDeny` |
| `denyRead` | No-op — reads outside `ro[]` are already inaccessible | Adds paths to the read denylist on top of the defaults |
| `allowWrite` | Adds paths to the write allowlist (`rw[]`) | Adds paths to the write allowlist (`rw[]`) |

### Making platform specificity clear to users

The asymmetry (`allowRead` means opposite things on each platform, `denyRead` is a no-op on Linux) is real and cannot be hidden without losing expressiveness. The strategy:

1. **`config.example.json`** groups fields with inline comments explaining platform scope:
   ```json
   {
     "sandbox": {
       "allowWrite": [],     // both platforms: extra writable paths
       "allowRead": [],      // Linux: extra readable paths; macOS: exceptions from the read denylist
       "denyRead": []        // macOS only: extra paths to block from reading; no effect on Linux
     }
   }
   ```

2. **README** has a table matching the one above — one row per field, two platform columns.

3. **Sandbox announcement** on macOS explicitly tells the agent which paths are denied and which are open, so the behaviour is observable without reading docs.

The alternative — platform-namespaced keys (`linux.allowRead`, `macos.denyRead`) — is more explicit but forces users to reason about platform at config-write time. The flat design with documentation is the better default; platform namespacing can be added later if users find the flat semantics confusing.

---

## Implementation architecture

The current code in `launcher.ts` has a clean seam:

```
findBwrap()       → string | null
bwrapLaunch(...)  → never   [Linux path]
launchEffect(...) → calls bwrapLaunch or falls through to non-sandbox
```

**Proposed additions**:

```
findSandboxTool():
  Linux:  findBwrap()           → BwrapBackend
  macOS:  /usr/bin/sandbox-exec → SandboxExecBackend

sandboxLaunch(backend, cwd, piArgs, mounts, pitConfig, settingsPath, escapeToken):
  Linux:  bwrapLaunch(...)  → never
  macOS:  sbplLaunch(...)   → never

SandboxMounts gains readDeny — see Type changes above.
```

New file: `pit/src/core/sandbox/sbpl.ts`
- `buildSbplProfile(mounts: SandboxMounts): string` — pure function, generates SBPL profile text from `rw[]` and `readDeny[]`; `ro[]` is ignored (reads are globally open via `(allow file-read*)`)
- Mirrors `buildSandboxMountSpec` in being pure and fully testable without a Mac

New function in `launcher.ts`:
- `sbplLaunch(cwd, piArgs, mounts, pitConfig, settingsPath?, escapeToken?): Promise<void>` — async (unlike `bwrapLaunch` which is sync). Builds the SBPL profile string, passes it inline via `-p`, sets up symlink-mirror agent dir, spawns the child with `spawn('sandbox-exec', ['-p', profile, nodeBin, ...], { stdio: 'inherit', env: filteredEnv })`, forwards SIGINT/SIGTERM to child, awaits child exit, then calls `process.exit()`. SIGKILL of the parent orphans the child — accepted, same behaviour as `@anthropic-ai/sandbox-runtime`.

`formatSandboxNote` in `pure.ts`:
- Signature becomes `formatSandboxNote(mounts: SandboxMounts, backend: 'bwrap' | 'sandbox-exec'): string`
- Behaviour driven by `mounts.readDeny` — see `formatSandboxNote` redesign above

---

## macOS filesystem path differences

The `ro[]` list on macOS is used for the announcement only — no SBPL read rules are emitted. The system path differences table below is retained for context but is no longer implementation-critical (reads are globally open).

The current `buildSandboxMountSpec` hardcodes Linux paths. A macOS variant needs a different system dir set:

| Linux mount | macOS equivalent |
|---|---|
| `/usr` | `/usr` (exists on macOS) |
| `/etc` | `/private/etc` (macOS), `/etc` is a symlink |
| `/lib`, `/lib64` | don't exist; macOS libs are in `/usr/lib`, `/System/Library` |
| `/bin`, `/sbin` | exist on macOS but are symlinks to `/usr/bin`, `/usr/sbin` |
| `/mnt/wsl` | doesn't exist on macOS |

New entries needed on macOS:
- `/System/Library/Frameworks` — needed for dyld
- `/System/Library/PrivateFrameworks` — needed for dyld
- `/private/var/db/dyld` — dyld shared cache (critical for ANY binary on macOS)
- `/private/var/tmp` — temp files
- `/Library/Developer/CommandLineTools` — if using CLT git
- Homebrew prefix: `/opt/homebrew` (Apple Silicon) or `/usr/local` (Intel) — **confirmed required**: Homebrew is at `/opt/homebrew` on GitHub Actions macos-14; without it the agent cannot find git, node, or any Homebrew-installed tool

`buildSandboxMountSpec` should accept a `platform: 'linux' | 'darwin'` parameter (or split into two functions) to select the right system dir set.

### Sandbox PATH

The sandboxed process PATH must include Homebrew prefixes or the agent's bash tool cannot find any Homebrew-installed binary:

```
${nodeDir}/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
```

Confirmed on GitHub Actions macos-14 (Apple Silicon): git is at `/opt/homebrew/bin/git`. Without this PATH, `git --version` and all Homebrew tools silently fail.

---

## Implementation notes

### SBPL rules must use real paths

SBPL operates on resolved (real) paths. On macOS `/tmp` → `/private/tmp`, `/var` → `/private/var`, `/etc` → `/private/etc`. `(allow file-write* (subpath "/tmp"))` will not match an access to `/private/tmp/pit-agent-XXXX/`. The `buildSbplProfile` function must call `realpathSync()` on every path before emitting a rule — agentDir, worktree, mirror dir, and all system paths in the grant lists.

### Mirror dir and `$TMPDIR`

`os.tmpdir()` on macOS returns `$TMPDIR`, which launchd sets per-user per-login to `/var/folders/xx/yyy/T/`. Using `mkdtemp()` would place the mirror there, requiring a broad `(allow file-write* (subpath "/var/folders"))` rule. Instead, create the mirror with `mkdtempSync('/private/tmp/pit-XXXX')` — a fixed, world-writable path, covered by a single narrow `(allow file-write* (subpath "/private/tmp"))` rule.

---

### Known SBPL requirements for Node.js

Derived from `@anthropic-ai/sandbox-runtime` (production Claude Code sandbox) and `@nqbao/pi-sandbox`. Copy as baseline; trim empirically.

**Mach services** (`allow mach-lookup`):
```
com.apple.logd  com.apple.system.logger
com.apple.system.opendirectoryd.libinfo
com.apple.system.opendirectoryd.membership
com.apple.bsd.dirhelper  com.apple.securityd.xpc
com.apple.coreservices.launchservicesd
com.apple.FontObjectsServer  com.apple.fonts
com.apple.lsd.mapdb  com.apple.PowerManagement.control
com.apple.system.notification_center  com.apple.SecurityServer
com.apple.cfprefsd.daemon  com.apple.cfprefsd.agent
com.apple.audio.systemsoundserver
com.apple.mDNSResponder  com.apple.mDNSResponderHelper  (network only)
com.apple.trustd.agent  (TLS cert verification, Go runtimes)
```

**IPC and kernel**:
```scheme
(allow ipc-posix-shm)              ; V8 shared memory
(allow ipc-posix-sem)              ; Python multiprocessing
(allow sysctl-read ...)            ; ~50 hw./kern./machdep. names — copy from ASRT
(allow sysctl-write (sysctl-name "kern.tcsm_enable"))  ; V8 thread calc
(allow user-preference-read)
(allow distributed-notification-post)
(allow iokit-open
  (iokit-registry-entry-class "IOSurfaceRootUserClient")
  (iokit-registry-entry-class "RootDomainUserClient")
  (iokit-user-client-class "IOSurfaceSendRight"))
(allow iokit-get-properties)
(allow system-socket
  (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))
```

**Unix sockets** (needed for pit-escape socket):
```scheme
(allow system-socket (socket-domain AF_UNIX))
(allow network-outbound
  (remote unix-socket (subpath "/path/to/pit-escape.sock")))
```

**Pseudo-TTY and device nodes** (confirmed required):
```scheme
(allow pseudo-tty)
(allow file-read* file-write* (literal "/dev/ptmx"))
(allow file-read* file-write* (regex #"^/dev/ttys"))
(allow file-ioctl (literal "/dev/null") (literal "/dev/tty") (literal "/dev/ptmx"))
; /dev/null and /dev/tty MUST have file-read* + file-write*, not just file-ioctl.
; git opens /dev/null for read+write on startup. Any subprocess that
; redirects stdin/stdout to /dev/null fails without this. Confirmed on macos-14.
(allow file-read* file-write* (literal "/dev/null"))
(allow file-read* file-write* (literal "/dev/tty"))
```

**A missing mach entry causes a hang, not a crash.** Start from the full list above and trim only with confirmed empirical testing on a Mac.

---

## Where you cannot research your way out — open grills

### Grill 1: SBPL `(deny default)` and dyld shared cache — RESOLVED

Resolved by adopting `(allow file-read*)`. Reads are globally open; dyld cache paths, Gatekeeper xattr reads, and system framework paths require no enumeration. Both reference implementations confirm this is the correct approach.

### Grill 2: SBPL + notarization and Gatekeeper — RESOLVED

Resolved by the same `(allow file-read*)` model. xattr reads for quarantine attribute checks are covered. No Gatekeeper interaction with denied paths.

### Grill 3: Ephemeral layers — feature gap on macOS

Not implemented on macOS. `sandbox-exec` cannot do overlayfs and the alternatives (APFS CoW clone, macFUSE) are either unreliable under crash or require a third-party kernel extension. The agent on macOS will not have access to parent repo's unversioned directories (e.g. `node_modules`) at the worktree path. The sandbox announcement on macOS omits the ephemeral overlay section.

### Grill 4: Shadow agent dir symlink gap — resolved for known dirs

Pi calls `ensureTool("fd")` and `ensureTool("rg")` at every interactive session startup, creating `agentDir/bin/` if it doesn't exist. If `bin/` is absent at mirror creation time, it gets created inside the temp mirror and the downloaded binaries vanish on exit (re-downloaded next session — annoying, not data loss).

Fix: pre-create all known agentDir subdirs in the real agentDir before mirroring (`bin/`, `sessions/`, `themes/`, `prompts/`, `git/`). SDK source confirms these are the only subdirs created during a normal session — package installs (`git/<host>/...`) run via `pi install` which bypasses the sandbox entirely. Unknown subdirs added in future SDK versions remain a residual risk, but impact is limited to transient data.

### Grill 7: Sandbox announcement — RESOLVED

Resolved by the `readDeny` field on `SandboxMounts` and the read-policy-driven `formatSandboxNote`. The formatter emits accurate text for each mode: whitelist mode says "No access: anything outside the mounts listed above"; blacklist mode says "No write access outside listed paths" and lists the denied read paths. The agent's self-model is correct on both platforms.

### DNS resolution inside the sandbox

`dns.resolve4` and the c-ares family use raw UDP sockets to the nameserver address from `/etc/resolv.conf`. On macOS, DNS is handled exclusively by mDNSResponder via mach IPC — there is no DNS daemon on `127.0.0.1:53`. c-ares gets `ECONNREFUSED`. Confirmed on GitHub Actions macos-14.

**Rule**: do not use `dns.resolve*` (c-ares) inside the sandbox. Use `dns.lookup` which goes through `getaddrinfo` → mDNSResponder via `com.apple.mDNSResponder` mach service. Node.js's `https.request` already uses this path, so AI API calls work correctly.

### Grill 8: Mach service list — baseline confirmed, trimming deferred

The full ASRT baseline has been validated on GitHub Actions macos-14 (Apple Silicon): `AuthStorage.create()` completes in under 700ms with no hang, DNS resolves, HTTPS reaches both AI providers, Unix socket (pit-escape pattern) connects, and git spawns correctly. All 32 probe scenarios pass.

Trimming individual entries to find the minimal set is deferred until after the production implementation exists. A missing entry causes a silent hang — each removal must be validated by a passing run of the full probe, not assumed safe.

### Grill 5: `sandbox-exec` profile syntax stability — risk accepted

SBPL is private Apple API. Risk accepted. If Apple removes `sandbox-exec`, the macOS sandbox backend breaks and pit falls back to running unsandboxed (same as today when bwrap is absent on Linux).

### Grill 6: Lifetime binding — SIGKILL gap accepted

`@anthropic-ai/sandbox-runtime` has the same gap: they use `spawn` + SIGINT/SIGTERM forwarding; a SIGKILL of the parent orphans the child. No macOS-native solution exists short of a privileged watchdog process. Accepted.

Implementation consequence: `sbplLaunch` must use `spawn` (async), not `spawnSync`. `spawnSync` returns no child handle, making signal forwarding impossible. `sbplLaunch` is async, spawns the child, forwards SIGINT/SIGTERM, and awaits child exit before calling `process.exit()`. This differs from `bwrapLaunch` which uses `spawnSync` (bwrap's `--die-with-parent` makes signal forwarding unnecessary on Linux).

---

## Summary

| Feature | macOS plan | Confidence |
|---|---|---|
| Closed filesystem | Write-closed only: `(allow file-read*)` globally, write allowlist | High — confirmed by two production implementations |
| Read grants | Announcement-only on macOS; SBPL emits no read rules | High |
| Read denylist | Default credential paths; user-extensible via `sandbox.denyRead` | High — design settled |
| Write grants | `(allow file-write* (subpath ...))` per `rw[]` entry | High |
| Env seal | `spawnSync({ env: filteredEnv })` | High — same shape as bwrapLaunch |
| Network policy | `(allow network*)` or restricted with proxy | High |
| System path grants | Covered by `(allow file-read*)`; mach/sysctl/device list validated on macos-14 | High — confirmed |
| Sandbox announcement | Read-policy-driven via `readDeny` field; backend name as parameter | High — design settled |
| Ephemeral layers | Feature gap on macOS — not implemented | Decided |
| Dir remap + package filtering | Symlink mirror in `/private/tmp`; hardlink for settings.json; pre-create known subdirs | High — validated on macos-14 |
| Identity isolation | Not applicable — no equivalent on macOS | N/A |
| Process isolation | Not applicable — no PID namespace on macOS | N/A |
| Lifetime binding | `spawn` + SIGTERM/SIGINT forwarding; SIGKILL orphans accepted (same as ASRT) | Decided |
| SBPL stability | risk accepted | Decided |
| Mach service list | ASRT baseline confirmed on macos-14; trimming deferred | High for baseline |
