# Plan: centralized bwrap platform mounts, dedup test sandbox setup

**Status: done (Phase 1). Phase 2 as separate audit.**

## Problem

1. `findBwrap()` hardcoded `/usr/bin/bwrap` and `/usr/local/bin/bwrap`, so Nix-installed bwrap was invisible.
2. Bwrap platform-specific mounts (`/mnt/wsl`, `/run/systemd/resolve`, `/lib`, `/lib64`, `/bin`, `/sbin`) are duplicated between production code and 11 hand-rolled test bwrap invocations.
3. Nix systems need `/nix` mounted inside bwrap for the node binary (ELF interpreter + shared libs are all in `/nix/store`), but there's no central place to add it.

## Root cause

Production code (`pure.ts`) defines platform mounts as data. `launcher.ts` bwrapLaunch() consumes them. But bwrapLaunch() calls `process.exit()`, so tests can't reuse it. Tests instead copy-paste raw bwrap args.

## What we do

### Phase 1 (this change)

1. **`pure.ts`**: add `{ path: "/nix", label: "system dirs", optional: true }` to the linux ro mount list. One line — production sandbox gets Nix store access.

2. **`launcher.ts`**: extract `buildBwrapArgs()` from `bwrapLaunch()` — a pure function that takes `SandboxMounts` and options and returns the arg array. `bwrapLaunch()` calls it, tests call it.

3. **Test files**: replace all hand-rolled bwrap args with `buildBwrapArgs()` calls. Nix mount (and all future platform mounts) come for free.

   Affected test sites:
   - `pit/tests/sandbox.test.ts` — runInBwrap helper + 4 other invocation sites
   - `pit/tests/resume.test.ts` — 2 invocation sites
   - `pit/src/resume.test.ts` — 1 invocation site
   - `pit/debug/bwrap-optional-mount-probe.test.ts` — 2 invocation sites

### Phase 2 (separate audit — see [test-audit.md](test-audit.md) for approach, [test-audit-research.md](test-audit-research.md) for findings)

Audit ALL tests for app code duplication. Seven categories identified: tmp dir lifecycle, git repo creation, bwrap availability checks, git worktree helpers, session file factories, pi mock helpers, escape mock server. Prioritised by duplication count and impact. Escape mock server deferred as low-value/high-churn.

## Alternatives considered

### A) Quick fix: add `--ro-bind-try /nix /nix` to every test site

Immediate fix but continues the copy-paste pattern. Adding another platform
would require touching 11+ sites again. Rejected.

### B) Separate module with all platform-specific binary mounts

A dedicated file (e.g. `platform-mounts.ts`) that exports the full set of
`--ro-bind-try` platform mounts as a flat string array. Tests spread it into
their args. Production code references the same array.

```typescript
// platform-mounts.ts
export const LINUX_PLATFORM_BWRAP_ARGS = [
  "--ro-bind-try", "/mnt/wsl",             "/mnt/wsl",
  "--ro-bind-try", "/run/systemd/resolve", "/run/systemd/resolve",
  "--ro-bind-try", "/nix",                 "/nix",
  "--ro-bind-try", "/lib",                 "/lib",
  "--ro-bind-try", "/lib64",               "/lib64",
  "--ro-bind-try", "/bin",                 "/bin",
  "--ro-bind-try", "/sbin",                "/sbin",
];
```

**Pros:** Simplest to use — one spread operator. No `SandboxMounts`
construction needed in tests.

**Cons:** Duplicates data with `pure.ts` (same paths live as `RoMount[]`
objects AND as a flat string array). Adding a mount means updating both.

**Current approach uses a variant of this:** `linuxPlatformRoMounts()`
exports `RoMount[]` objects (typed, label-bearing) rather than raw strings.
Both production and tests consume the same list, avoiding the double-source
problem. `buildBwrapArgs()` converts the objects to bwrap flags.

### C) Mount entire host filesystem read-only as base

The macOS sandbox-exec backend uses deny-by-default: `/` is mounted read-only,
then specific paths are selectively allowed. Bwrap could do the same:

```bash
bwrap --ro-bind / / --bind /tmp /tmp --bind /home/user/work /home/user/work ...
```

Instead of `--tmpfs /` (empty base + selective mounts), we'd `--ro-bind / /`
(full filesystem, read-only) + selective `--bind` for writable paths.

**Pros:**
- Zero platform-specific mounts needed. `/nix`, `/mnt/wsl`, `/lib` — all
already visible because `/` is mounted.
- Same mental model as macOS sandbox-exec (one sandbox strategy, not two).
- Future-proof: new distro quirks don't need new mounts.

**Cons:**
- **Security:** read-only `/` exposes far more of the host filesystem than
`--tmpfs /`. All of `/etc`, `/home`, `/var`, etc. becomes readable. The
current `--tmpfs /` approach guarantees the sandbox sees nothing except
explicitly mounted paths.
- **Leaks host paths:** `ls /home` shows real usernames, `cat /etc/passwd`
works. Current approach keeps these invisible.
- **Bwrap order sensitivity:** `--ro-bind / /` followed by `--bind /tmp /tmp`
works (later bind overrides earlier ro-bind). But this is subtle and easy to
get wrong — if a mount order changes, a writable path could accidentally
become read-only.
- **Accidental exposure:** a poorly-sandboxed script can `require('fs').readFileSync('/etc/shadow')`
if the host has it readable. With `--tmpfs /`, that path doesn't exist at all.

**Verdict:** The security regression is significant. The current `--tmpfs /`
approach is the stronger sandbox — nothing exists unless explicitly granted.
However, we could consider a hybrid: `--ro-bind / /` only for test helpers
(where security doesn't matter, correctness does) while production keeps
`--tmpfs /`.

This is worth discussing but is out of scope for this change. Would require
a full security review and likely a config flag (`--sandbox-mode strict|permissive`).
