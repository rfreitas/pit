# Plan: per-mode extension configuration, remove settings filtering

## Confirmed facts (from code + tests)

**PI_CODING_AGENT_DIR:**
`getAgentDir()` in pi SDK = `join(homedir(), CONFIG_DIR_NAME, "agent")` where
`CONFIG_DIR_NAME = ".pi"`. With `--clearenv` + `--setenv HOME $HOME`, pi defaults
to `~/.pi/agent` — the real agent dir — which is already rw-mounted.
**No explicit `--setenv PI_CODING_AGENT_DIR` needed.**

**RW mount + symlinks inside:**
Tested in bwrap:
- regular file: reads/writes fine ✓
- symlink → mounted target: reads/writes fine ✓
- symlink → unmounted target: `ENOENT` ✗

So a symlinked `settings.json` pointing outside the sandbox still fails —
but now it's a clean `ENOENT` from the application (not a bwrap startup crash),
and it only affects the unusual case. The translation layer idea (mount the
symlink target's parent if detected) remains applicable here as a follow-up
but is out of scope for this change.

**Reload hook:**
`createReloadHook` listens for `session_shutdown { reason: "reload" }` and
calls `refresh-settings` on pit-escape. That op re-reads real settings and
rewrites the filtered temp file. With no filtering, the op is gone. The hook
becomes a no-op. **`createReloadHook` can be removed from `createExtensionFactories`.**
Pi handles its own reload natively — re-reads `settings.json`, re-loads
extensions — no pit coordination needed.

**`extensionArgs()`:** exported, never called, dead code. Remove.

---

## What changes

### Removed
- `settingsPath` everywhere: `bwrapLaunch`, `launchEffect`, `startPitEscapeEffect`,
  `applyEscapeEffect`, pit-escape server args, program.ts call sites
- `createTempSettingsFileEffect`, `writeFilteredSettings`, `applyDenylist`
  in `core/sandbox/io.ts`
- `shadowAgentMountArgs` + settingsPath handling in `buildBwrapArgs`
- `replaceSymlinkForBwrap` + `copyFileSync` import
- `PI_CODING_AGENT_DIR=/pit-agent` override in `bwrapLaunch`
- `opRefreshSettings` + `hostSettingsPath` arg in pit-escape server
- `createReloadHook` from `createExtensionFactories` (both sandbox and non-sandbox)
- `extensionArgs()` — dead code
- `denyPackages` from `PitConfig` type and `pit/config.json`
- `SettingsWriteError` if only used by `writeFilteredSettings`

### Added
- `nonSandboxExtensions?: string[]` to `PitConfig`

### Changed
- `launchEffect` non-sandbox path: spreads `nonSandboxExtensionFlags` into piArgs
- `createExtensionFactories`: remove `createReloadHook` from the returned array
- `startPitEscapeEffect`: remove `settingsPath` param, simplify server spawn args

---

## How it works

**Sandbox mode:**
```
bwrapLaunch → inner.ts → main(piArgs, {
  extensionFactories: createExtensionFactories(sock, tok, true)
})
```
- `PI_CODING_AGENT_DIR` not set → pi uses `~/.pi/agent` (rw-mounted)
- pi reads/writes real `settings.json` directly
- pi loads packages from `settings.json` — unrestricted
- pit bundled extensions load via extensionFactories
- `nonSandboxExtensions` NOT passed

**Non-sandbox mode:**
```
launchEffect → main([...piArgs, ...nonSandboxExtFlags], {
  extensionFactories: createExtensionFactories(sock, tok, false)
})
```
where `nonSandboxExtFlags = pitConfig.nonSandboxExtensions?.flatMap(p => ["--extension", p]) ?? []`

- pi reads/writes real `settings.json` directly
- pi loads packages from `settings.json` — unrestricted
- pit bundled extensions load via extensionFactories
- `nonSandboxExtensions` from pit config passed as `--extension` flags

**Security model:**
- Sandbox (bwrap): packages from `settings.json` load but are contained by the
  sandbox. Escape socket auth prevents unauthorized pit-escape ops.
- Non-sandbox: packages load AND security extensions from `nonSandboxExtensions`
  are active (e.g. audit, monitoring extensions that assume host filesystem access).

---

## Grills

### 1. `nonSandboxExtensions` path resolution
Paths in `pit/config.json` may be relative or absolute. `settings.json.extensions`
uses absolute paths. We should resolve relative paths against `pitDir` before
passing as `--extension`. Filter out non-existent paths with a warning, not a crash.

### 2. `--no-extensions` interaction
If user passes `--no-extensions` to pit, it flows to piArgs. Pi won't load
`--extension` flags. `nonSandboxExtensions` would be silently ignored.
`extensionFactories` still load (API, not flags). This seems correct — user
explicitly asked for no extensions.

### 3. Does `createReloadHook` do anything besides `refresh-settings`?
Confirmed: it only calls `refresh-settings`. Nothing else. Safe to remove.

### 4. Symlinked `settings.json` still fails for unmounted targets
If `~/.pi/agent/settings.json` points to a path outside the sandbox, pi gets
`ENOENT`. This is a clean error (not a bwrap crash) but still a failure.
Fix: the translation layer (detect symlink, mount target's parent) as a
follow-up. Not blocking for this change.

### 5. `startPitEscapeEffect` — `settingsPath` param removal
pit-escape is launched as a child process. Its argv changes. If any other code
or test hardcodes the 7-arg invocation, it breaks. Audit all call sites.
There's only one: `launcher.ts`. Tests mock it.

### 6. `applyEscapeEffect` in program.ts calls `startPitEscapeEffect` with `settingsPath`
This is called at every launch path. Removing `settingsPath` from
`startPitEscapeEffect` means removing it from `applyEscapeEffect` too.
`applyEscapeEffect` currently receives it from `createTempSettingsFileEffect`.
That whole chain collapses cleanly — remove in one pass top to bottom.

### 7. Symlink translation — NOT supported

If `~/.pi/agent/settings.json` is a symlink pointing outside the sandbox,
reads and writes fail with `ENOENT`. This is a fundamental kernel constraint:
the kernel resolves symlinks to their final path before checking mount
permissions. The sandbox has no say.

We considered a "translation layer" that detects symlinks in mount paths and
automatically mounts their targets. Rejected:

- **Too error-prone.** Multi-hop symlinks, dangling symlinks, relative
  symlinks — each needs special handling.
- **Mount ordering issues.** Adding a ro-bind-try for a symlink target's
  parent can accidentally make previously rw-mounted paths read-only.
- **Security exposure.** Mounting the symlink target's parent directory
  incidentally exposes all sibling files.
- **Not needed for the common case.** Dotfiles setups that use hardlinks
  (same inode, no kernel resolution), bare git repos (`$HOME` as worktree),
  or real files all work fine with rw mounts.

**Policy:** pit does not support symlinked settings.json to unmounted
locations. The user is responsible for ensuring settings.json is a real file
or hardlink on the host. If it's a symlink to an unmounted path, pit will
surface the clean `ENOENT` error (not a bwrap startup crash). Documents
advise using hardlinks or bare git repos for dotfile management when using pit.
