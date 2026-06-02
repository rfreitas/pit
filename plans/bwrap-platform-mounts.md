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

### Phase 2 (separate audit, not in this change)

Audit ALL tests for app code duplication — create a separate plan. Known candidates:
- Git repo setup helpers (repeated across e2e, resume, sandbox tests)
- Session setup helpers
- Tmp dir management
- Agent dir creation

The `plans/` dir already has `pit-non-interactive-modes.md` which touches on test infrastructure — link to this.

## Alternatives considered

- **Just add `--ro-bind-try /nix /nix` to every test site**: immediate fix but continues duplication. Rejected.
- **Make bwrapLaunch() not exit**: too invasive, changes production behavior. Rejected.
- **Tests use bwrapLaunch() directly**: can't — it exits the process and uses `stdio: "inherit"`. Rejected.
