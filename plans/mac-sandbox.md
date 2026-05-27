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

`/usr/bin/sandbox-exec -f profile.sb <cmd>` installs a MAC (Mandatory Access Control) policy via the TrustedBSD kernel hook (same mechanism Apple uses for App Sandbox). The SBPL profile language is Scheme-like:

```scheme
(version 1)
(deny default)                              ; deny everything not explicitly allowed
(allow file-read* (subpath "/usr"))
(allow file-write* (subpath "/home/user/my-worktree"))
(allow network-outbound)
(allow process-exec*)
(allow signal (target self))
```

This is **deny-based, not namespace-based**. The process sees the real filesystem layout but ACCESS is controlled. There is no isolated mount table.

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

**Linux**: empty tmpfs at `/`; nothing visible unless explicitly mounted in.

**macOS**: no equivalent. `sandbox-exec (deny default)` blocks access to unlisted paths but the filesystem layout is still visible (stat succeeds, content is denied). You cannot present an empty `/`.

**Plan**: Accept this. With `(deny default)` the agent can't read unlisted paths. Visibility of path names (stat) is a weaker guarantee, acceptable for this threat model (see security.md: IPC is already unplugged).

---

### 2. Read grants (`--ro-bind PATH PATH`)

**Linux**: bind mount with `MS_RDONLY`.

**macOS sandbox-exec equivalent**:
```scheme
(allow file-read* (subpath "/usr"))
(allow file-read* (subpath "/etc"))
```

**Plan**: `buildSandboxMountSpec` already produces `SandboxMounts.ro[]`. A new `sbplLaunch` function iterates that list and emits `(allow file-read* (subpath "…"))` rules. Paths marked `optional` need to be wrapped in `(when (file-exists? "…") ...)` — but SBPL has no such conditional. They must be unconditionally allowed; missing paths just never match any access. This is fine.

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

SandboxMounts stays unchanged — it already abstracts the mount spec cleanly.
```

New file: `pit/src/core/sandbox/sbpl.ts`
- `buildSbplProfile(mounts: SandboxMounts): string` — pure function, generates SBPL profile text
- Mirrors `buildSandboxMountSpec` in being pure and fully testable without a Mac

New function in `launcher.ts`:
- `sbplLaunch(cwd, piArgs, mounts, pitConfig, settingsPath?, escapeToken?)` — builds profile, writes to tmpfile, sets up symlink-mirror agent dir, calls `sandbox-exec -f tmpfile node inner.ts`

Updated `formatSandboxNote` in `pure.ts`:
- Replace `**Sandbox (bwrap):**` header text with a platform-specific variant, or parameterise: `formatSandboxNote(mounts, backend: 'bwrap' | 'sandbox-exec')`

---

## macOS filesystem path differences

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
- Homebrew prefix: `/opt/homebrew` (Apple Silicon) or `/usr/local` (Intel)

`buildSandboxMountSpec` should accept a `platform: 'linux' | 'darwin'` parameter (or split into two functions) to select the right system dir set.

---

## Implementation notes

### SBPL rules must use real paths

SBPL operates on resolved (real) paths. On macOS `/tmp` → `/private/tmp`, `/var` → `/private/var`, `/etc` → `/private/etc`. `(allow file-write* (subpath "/tmp"))` will not match an access to `/private/tmp/pit-agent-XXXX/`. The `buildSbplProfile` function must call `realpathSync()` on every path before emitting a rule — agentDir, worktree, mirror dir, and all system paths in the grant lists.

### Mirror dir and `$TMPDIR`

`os.tmpdir()` on macOS returns `$TMPDIR`, which launchd sets per-user per-login to `/var/folders/xx/yyy/T/`. Using `mkdtemp()` would place the mirror there, requiring a broad `(allow file-write* (subpath "/var/folders"))` rule. Instead, create the mirror with `mkdtempSync('/private/tmp/pit-XXXX')` — a fixed, world-writable path, covered by a single narrow `(allow file-write* (subpath "/private/tmp"))` rule.

---

## Where you cannot research your way out — open grills

### Grill 1: SBPL `(deny default)` and dyld shared cache

When `(deny default)` is active, dyld must be able to read the shared cache at `/private/var/db/dyld/dyld_shared_cache_arm64e` (Apple Silicon) or equivalent. If this read is blocked, the process cannot start at all — every binary fails to exec. The exact paths dyld needs to read cannot be fully determined from documentation because:

- The dyld shared cache path changes with macOS versions
- Rosetta 2 adds another cache at a different path
- dyld also reads from `/System/Volumes/Preboot/...` on some configurations

Need to run a real Node.js process under `sandbox-exec (deny default)` on macOS and capture every denied path via `fs_usage` or `sandbox-exec` trace mode. This is empirical work that cannot be done from a Linux environment. Risk: a Node.js update or macOS update silently adds a new dyld path and the sandbox breaks on upgrade.

### Grill 2: SBPL + notarization and Gatekeeper

On macOS 13+ with SIP enabled, running `sandbox-exec` on a sandboxed `node` binary may interact with Gatekeeper and Notarization checks. If `(deny default)` blocks `xattr` reads on the node binary (used for quarantine attribute checks), the exec might be denied. The exact set of `xattr-read` and `file-read-metadata` permissions needed is not documented and differs between Homebrew-installed Node, mise-installed Node, and system Node. Cannot be resolved without empirical testing on a real Mac.

### Grill 3: The overlay problem has no clean solution

`sandbox-exec` cannot do overlayfs. Full stop. The three options all have hard problems:

- **APFS CoW clone**: fast, but leaves real filesystem state. Crash = stale directories in the worktree that the agent can see and git-add. The "writes vanish on exit" guarantee from the session announcement would be a lie if the process is hard-killed. Cannot guarantee cleanup without a companion process outside the sandbox. Also: non-APFS volumes (HFS+, network shares, SMB-mounted repos) don't support `clonefile`, so `cp -c` silently falls back to a full copy, which is slow for large `node_modules`.

- **Skip overlays (warn)**: functionally correct but the agent loses access to parent's node_modules / dist / etc. Whether that matters depends on what Pi is asked to do. If the agent needs to run scripts or tests that rely on node_modules existing at the worktree root, it will fail in a confusing way. This needs a UX decision, not just an engineering choice.

- **macFUSE overlayfs**: requires user to install a third-party signed kernel extension. macOS aggressively prompts and re-prompts for approval. Completely impractical as a default.

### Grill 4: Shadow agent dir symlink gap — resolved for known dirs

Pi calls `ensureTool("fd")` and `ensureTool("rg")` at every interactive session startup, creating `agentDir/bin/` if it doesn't exist. If `bin/` is absent at mirror creation time, it gets created inside the temp mirror and the downloaded binaries vanish on exit (re-downloaded next session — annoying, not data loss).

Fix: pre-create all known agentDir subdirs in the real agentDir before mirroring (`bin/`, `sessions/`, `themes/`, `prompts/`, `git/`). SDK source confirms these are the only subdirs created during a normal session — package installs (`git/<host>/...`) run via `pi install` which bypasses the sandbox entirely. Unknown subdirs added in future SDK versions remain a residual risk, but impact is limited to transient data.

### Grill 5: `sandbox-exec` profile syntax stability

SBPL is private Apple API, not documented in any public developer documentation. Everything known about it comes from reverse-engineering Apple's own profiles and community research. Apple has been moving toward App Sandbox (entitlements-based, requires code signing) and away from `sandbox-exec` for third-party use. A future macOS version may remove or severely restrict `sandbox-exec` for user processes, silently breaking the entire macOS sandbox backend with no fallback. Cannot be mitigated by research — requires a bet on how long Apple tolerates `sandbox-exec` in third-party tooling.

### Grill 6: `--die-with-parent` correctness

The polling approach (check ppid in a setInterval) has a window: if the parent is killed and the ppid is immediately reassigned to a new process, the child never detects the death. The kqueue approach requires separate thread or event loop integration. Whether Node.js's event loop + kqueue correctly delivers `EVFILT_PROC NOTE_EXIT` for the parent PID in all exit scenarios (SIGKILL, crash, graceful exit) needs empirical verification on macOS. It is not equivalent to `prctl(PR_SET_PDEATHSIG)`, which is synchronous at the kernel level.

---

## Summary

| Feature | macOS plan | Confidence |
|---|---|---|
| Closed filesystem | `(deny default)` — weaker: layout visible, content blocked | High |
| Read grants | `(allow file-read* (subpath ...))` | High — SBPL syntax well-known |
| Write grants | `(allow file-read*/file-write* ...)` | High |
| Env seal | `spawnSync({ env: filteredEnv })` | High — standard Node.js, same shape as bwrapLaunch |
| Network policy | `(allow network-outbound)` | High |
| System path grants (macOS paths) | `/System/Library`, `/private/var/db/dyld` etc. | Medium — exact set needs empirical testing (Grill 1) |
| Ephemeral layers | APFS clone or skip | Low — both options have hard problems (Grill 3) |
| Dir remap + package filtering | Symlink mirror in `/private/tmp`; pre-create known subdirs | Medium — unknown future SDK subdirs are residual risk |
| Identity isolation | Not applicable — no equivalent on macOS | N/A |
| Process isolation | Not applicable — no PID namespace on macOS | N/A |
| Lifetime binding | ppid polling or kqueue | Medium — correctness under SIGKILL unclear (Grill 6) |
| SBPL stability | bet on `sandbox-exec` longevity | Low — private API, deprecation risk (Grill 5) |
| SBPL + dyld | unknown exact paths | Low — cannot determine without Mac hardware (Grill 1+2) |
