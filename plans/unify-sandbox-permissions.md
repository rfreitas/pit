# Unify Sandbox Permission Model

> **Status:** Planning
> **Date:** 2026-06-07
> **Depends on:** `unify-sandbox-paths-via-inner.md`

## Problem

The two platforms use fundamentally different permission models:

**Linux (bwrap):** default-deny
- Creates empty tmpfs at `/`
- Explicitly ro-binds each allowed path: `/usr`, `/etc`, `/lib`, `/lib64`, `/bin`, `/sbin`, `/nix`, `/mnt/wsl`, `/run/systemd/resolve`
- Platform-specific mount list (`linuxPlatformRoMounts()`)
- Must be updated whenever a new system path is needed

**macOS (sandbox-exec):** default-allow-reads
- `(allow file-read*)` — reads are globally open
- Explicit deny for credentials (`~/.ssh`, `~/.aws`, etc.)
- No platform-specific ro lists
- Just works with any tool installation

The Linux model is more secure but requires maintaining an ever-growing list of system paths. The macOS model is simpler and more flexible.

## Proposed Change

Make Linux match macOS: read everything by default, deny specific credential paths.

---

## Unified Permission Spec

### Schema

```typescript
type SandboxPermissionSpec = {
  readDeny: Array<{ path: string; label: string }>;
  writeAllow: Array<{ path: string; label: string; optional?: boolean }>;
};
```

### Default Values

```typescript
const DEFAULT_SANDBOX_PERMISSIONS: SandboxPermissionSpec = {
  readDeny: [
    { path: "~/.ssh",                     label: "credentials" },
    { path: "~/.aws",                     label: "credentials" },
    { path: "~/.gnupg",                   label: "credentials" },
    { path: "~/.config/gh",               label: "credentials" },
    { path: "~/.config/gcloud",           label: "credentials" },
    { path: "~/.azure",                   label: "credentials" },
    { path: "~/.config/op",               label: "credentials" },
    { path: "~/.netrc",                   label: "credentials" },
  ],
  writeAllow: [
    { path: "{cwd}",                      label: "worktree" },
    { path: "/tmp",                       label: "temp dir" },
    { path: "{agentDir}",                 label: "Pi config dir" },
    { path: "~/.npm",                     label: "npm cache",      optional: true },
    { path: "~/.local/share/mise/shims",  label: "mise shims",     optional: true },
    { path: "{nodeDir}/lib/node_modules", label: "Node.js global modules" },
    { path: "{nodeDir}/bin",              label: "Node.js bin" },
  ],
};
```

Path templates (`~`, `{cwd}`, `{agentDir}`, `{nodeDir}`) are resolved at runtime.

### User Config Override

User's `~/.pi/pit/config.json` extends the defaults:

```json
{
  "sandbox": {
    "denyRead": ["~/.config/custom-secret"],
    "allowWrite": ["/data/scratch"]
  }
}
```

These are appended to the defaults.

**`allowRead` is removed** from the user config schema — everything is readable by default, so there's nothing to explicitly allow.

---

## How It's Applied

### Linux (bwrap)

```bash
--ro-bind / /                                    # read everything
--dev /dev --proc /proc                          # fresh special fs
--bind {cwd} {cwd}                               # write allows
--bind /tmp /tmp
--bind {agentDir} {agentDir}
...
--tmpfs ~/.ssh                                   # deny reads (hide with empty dir)
--tmpfs ~/.aws
...
```

**How deny works:** `--tmpfs <path>` creates an empty tmpfs that overlays the real directory. The agent sees an empty directory instead of the real credentials. Mounts are processed in order — the deny tmpfs entries come after `--ro-bind / /`, which is structurally guaranteed by the code (separate arrays processed in sequence in `buildBwrapArgs`).

**Side effects:**
- tmpfs is writable — agent can write to `~/.ssh` inside sandbox, but writes are ephemeral
- `/sys` becomes readable (kernel params, hardware info) — minor information leak, generally safe
- `/dev` and `/proc` are overlaid with fresh mounts via `--dev /dev --proc /proc`

### macOS (sandbox-exec)

```scheme
(allow file-read*)                               ; read everything
(allow file-write* (subpath "{cwd}"))             ; write allows
(allow file-write* (subpath "/tmp"))
...
(deny file-read* (subpath "~/.ssh"))             ; deny reads
(deny file-read* (subpath "~/.aws"))
...
```

No change from current macOS behaviour — it already uses this model.

---

## Implementation

### pit/src/core/sandbox/pure.ts

**Replace `buildSandboxMountSpec`** with a simplified version:

```typescript
export const buildSandboxMountSpec = (params: Readonly<{
  home: string;
  cwd: string;
  agentDir: string;
  extensionMounts: string[];
  nodeDir: string;
  gitRwMounts: Array<{ path: string; label?: string }>;
  overlayDirs: OverlayMount[];
  pitConfig?: Readonly<PitConfig>;
}>): SandboxMounts => {
  const { home, cwd, agentDir, extensionMounts, nodeDir, gitRwMounts, overlayDirs, pitConfig } = params;

  // Resolve path templates
  const resolve = (p: string): string =>
    p.startsWith("~") ? join(home, p.slice(2))
    : p.replace("{cwd}", cwd)
       .replace("{agentDir}", agentDir)
       .replace("{nodeDir}", nodeDir);

  // Merge defaults + user config
  const userDeny = (pitConfig?.sandbox?.denyRead ?? []).map(p => ({ path: p, label: "user deny" }));
  const userWrite = (pitConfig?.sandbox?.allowWrite ?? []).map(p => ({ path: p, label: "user write grant" }));

  const readDeny = [...DEFAULT_SANDBOX_PERMISSIONS.readDeny, ...userDeny]
    .map(m => ({ ...m, path: resolve(m.path) }));

  const rw = [
    ...gitRwMounts,
    ...DEFAULT_SANDBOX_PERMISSIONS.writeAllow.map(m => ({ ...m, path: resolve(m.path) })),
    ...extensionMounts.map(p => ({ path: p, label: "Pi extensions" })),
    ...userWrite,
  ];

  return {
    rw,
    readDeny,
    overlay: overlayDirs,
    backend: 'unified',  // both platforms use the same spec
  };
};
```

**Remove entirely:**
- `linuxPlatformRoMounts()` — no more /nix, /lib, /lib64, /mnt/wsl, etc.
- Platform-specific ro lists (/usr, /etc vs /usr, /private/etc, /Library)
- The `platform` parameter
- `MACOS_DEFAULT_READ_DENY` — merged into `DEFAULT_SANDBOX_PERMISSIONS.readDeny`

### pit/src/launcher/index.ts (buildBwrapArgs)

**Replace** the tmpfs + explicit ro-bind approach:

```typescript
export const buildBwrapArgs = (
  mounts: Readonly<SandboxMounts>,
  opts: Readonly<{ cwd: string; scriptPath?: string }>,
): string[] => {
  const rwArgs = mounts.rw.flatMap(m =>
    [m.optional ? "--bind-try" : "--bind", m.path, m.path]
  );
  const overlayArgs = (mounts.overlay ?? []).flatMap(m => {
    mkdirSync(m.dest, { recursive: true });
    return ["--overlay-src", m.src, "--tmp-overlay", m.dest];
  });
  const denyArgs = (mounts.readDeny ?? []).flatMap(m =>
    ["--tmpfs", m.path]
  );

  const pitMounts = opts.scriptPath ? resolvePitMounts(opts.scriptPath, opts.cwd) : null;
  const dynamicMountArgs = pitMounts
    ? ["--ro-bind", pitMounts.pitSrcDir, pitMounts.pitSrcDir,
       "--ro-bind", pitMounts.pitNodeModules, pitMounts.pitNodeModules]
    : [];

  return [
    "--ro-bind", "/", "/",           // read everything
    "--dev", "/dev", "--proc", "/proc",  // fresh special fs
    ...rwArgs,                         // write allows
    ...overlayArgs,                    // overlays
    ...denyArgs,                       // deny reads (always after ro-bind)
    ...dynamicMountArgs,
    "--unshare-user", "--unshare-pid", "--die-with-parent",
    "--chdir", opts.cwd,
  ];
};
```

### SandboxMounts type

Update to include `readDeny` for both platforms:

```typescript
type SandboxMounts = {
  rw: RwMount[];
  readDeny?: Array<{ path: string; label: string }>;
  overlay?: OverlayMount[];
  backend: 'unified';
};
```

The `ro` field is removed — no more explicit read-only mounts.

---

## Current Linux Permission List (for reference)

This is what gets eliminated:

### Read-only (ro) — 13 entries
| Path | Label | Optional |
|---|---|---|
| `~/.gitconfig` | home dotfiles | yes |
| `~/.config/git` | home dotfiles | yes |
| `~/.npmrc` | home dotfiles | yes |
| `~/.local/share/mise/installs` | home dotfiles | yes |
| `/usr` | system dirs | no |
| `/etc` | system dirs | no |
| `/mnt/wsl` | system dirs | yes |
| `/run/systemd/resolve` | system dirs | yes |
| `/nix` | system dirs | yes |
| `/lib` | system dirs | yes |
| `/lib64` | system dirs | yes |
| `/bin` | system dirs | yes |
| `/sbin` | system dirs | yes |

### Read-write (rw) — 8 entries
| Path | Label | Optional |
|---|---|---|
| git rw mounts | (dynamic) | no |
| cwd (worktree) | (no label) | no |
| `/tmp` | temp dir | no |
| agentDir | Pi config dir | no |
| `~/.npm` | npm cache | yes |
| `~/.local/share/mise/shims` | mise shims | yes |
| `nodeDir/lib/node_modules` | Node.js global modules | no |
| `nodeDir/bin` | Node.js bin | no |

### Read deny — none (not supported on Linux currently)

After this change: 0 ro entries, same rw entries, 8 read deny entries. Same model as macOS.

---

## Security Tradeoffs

| Concern | Impact | Mitigation |
|---|---|---|
| Agent can read any file on host | Broader read access than current allowlist | Denylist covers common credential paths |
| `/sys` becomes readable | Minor info leak (hardware, kernel params) | Generally safe, no secrets in /sys |
| tmpfs deny is writable | Agent can write to empty `~/.ssh` | Writes are ephemeral, vanish on exit |
| Symlinked credential dirs | tmpfs mounts over symlink, not target | Unlikely for standard credential paths |
| New credential locations | Denylist can't cover everything | Same limitation as macOS, user can extend via config |
| Agent sees empty credential dirs | May confuse agent trying to use them | Minor UX issue, not a security issue |

---

## Migration Checklist

- [ ] Define `DEFAULT_SANDBOX_PERMISSIONS` in pure.ts
- [ ] Rewrite `buildSandboxMountSpec` — remove platform parameter, remove ro lists
- [ ] Remove `linuxPlatformRoMounts()`
- [ ] Remove `MACOS_DEFAULT_READ_DENY`
- [ ] Update `buildBwrapArgs` — `--ro-bind / /` + `--tmpfs` deny entries
- [ ] Update `SandboxMounts` type — remove `ro`, add `readDeny`
- [ ] Update `buildSbplProfile` — consume `readDeny` from unified spec
- [ ] Remove `allowRead` from `PitConfig` schema
- [ ] Update tests — remove platform-specific ro mount tests
- [ ] Add tests — verify deny entries produce `--tmpfs` args
- [ ] Manual test — verify credentials are inaccessible inside sandbox
- [ ] Manual test — verify `/sys` is readable (acceptable tradeoff)
- [ ] Update README — document new permission model
- [ ] Update config.example.json — remove `allowRead`, document `denyRead`

---

## Testing Strategy

1. **Unit tests** for `buildSandboxMountSpec`
   - Verify readDeny includes default credentials + user config
   - Verify writeAllow includes defaults + user config
   - Verify path template resolution (~, {cwd}, {agentDir}, {nodeDir})

2. **Unit tests** for `buildBwrapArgs`
   - Verify `--ro-bind / /` is first mount
   - Verify `--dev /dev --proc /proc` come after
   - Verify `--tmpfs` entries come after ro-bind (structurally guaranteed)
   - Verify rw entries are present

3. **Integration tests**
   - Spawn bwrap with new args, verify `~/.ssh` is empty inside sandbox
   - Verify `/usr/bin/git` is accessible (was previously explicit ro-bind)
   - Verify `/nix/store` is accessible (was previously explicit ro-bind)

4. **Manual testing**
   - Run pit on Linux, verify agent can use git, node, npm
   - Run pit on macOS, verify no regression
   - Try to read `~/.ssh/id_rsa` inside sandbox — should see empty dir
   - Try to write to `~/.ssh/test` inside sandbox — should succeed (ephemeral)
