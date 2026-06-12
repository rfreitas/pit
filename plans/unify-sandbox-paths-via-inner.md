# Unify Sandbox & Non-Sandbox Paths via inner.ts

> **Status:** Planning
> **Date:** 2026-06-07

## Problem

Currently pit has two code paths for launching pi:

1. **Sandbox mode** (Linux bwrap / macOS sandbox-exec): spawns `inner.ts` as a child process
2. **Non-sandbox mode** (`pit --no-sandbox`): calls `main()` in-process within pit itself

This duplication causes:
- Maintenance burden (two paths to keep in sync)
- Inconsistent env var handling between platforms
- Hardcoded platform-specific PATH logic
- Confusion about which code path handles what

## Solution

Unify both paths to spawn `inner.ts`. The only difference is whether the child process is wrapped in bwrap/sandbox-exec or runs directly.

---

## Implementation Plan

### 1. Add PIT_SANDBOXED Environment Variable

**Purpose:** Signal to inner.ts whether it's running in sandbox mode (controls UI status bar).

**Changes:**

#### pit/src/env.ts
Add helper to delete the env var:
```typescript
export const deletePitSandboxed = (): void => {
  delete process.env.PIT_SANDBOXED;
};
```

#### pit/src/launcher/inner.ts
Read PIT_SANDBOXED and pass to createExtensionFactories:
```typescript
import { deletePitSandboxed, deletePitEscapeToken, bootstrapProcess } from "../env.ts";

export const runInner = async (argv: string[], env: NodeJS.ProcessEnv) => {
  bootstrapProcess();
  
  const sandboxed = env.PIT_SANDBOXED === "1";
  deletePitSandboxed();
  
  const token = env.PIT_ESCAPE_TOKEN ?? "";
  deletePitEscapeToken();
  const socketPath = env.PIT_ESCAPE_SOCKET ?? "";

  await main(argv, {
    extensionFactories: createExtensionFactories(socketPath, token, sandboxed),
  });
};
```

### 2. Unify Environment Variable Handling

**Purpose:** Eliminate duplication between Linux (bwrap --setenv flags) and macOS (buildSealedEnv).

**Changes:**

#### pit/src/core/sandbox/pure.ts

**Add** unified `buildSandboxEnv()` function:
```typescript
export const buildSandboxEnv = (
  config: PitConfig,
  env: Record<string, string | undefined>,
  escapeToken?: string,
): Record<string, string> => {
  const base: Record<string, string> = {
    PI_CODING_AGENT: "true",
    PIT_SANDBOXED: "1",
  };
  
  if (escapeToken) {
    base.PIT_ESCAPE_TOKEN = escapeToken;
  }
  
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
```

**Key change:** Forward PATH from host instead of constructing platform-specific paths. This:
- Eliminates hardcoded /opt/homebrew paths for macOS
- Works with any package manager (nix, asdf, mise, volta, etc.)
- Simpler and more flexible

**Remove:**
- `buildSealedEnv()` (replaced by `buildSandboxEnv()`)
- `allowedEnvArgs()` (logic moved into `buildSandboxEnv()`)

#### pit/src/launcher/index.ts

**Update bwrapLaunch()** to use `buildSandboxEnv()`:
```typescript
const env = buildSandboxEnv(pitConfig, process.env, escapeToken);

const envArgs: string[] = [
  "--clearenv",
  ...Object.entries(env).flatMap(([k, v]) => ["--setenv", k, v]),
];
```

**Update sbplLaunch()** to use `buildSandboxEnv()`:
```typescript
const env = buildSandboxEnv(pitConfig, process.env, escapeToken);

const child = spawn(
  "/usr/bin/sandbox-exec",
  ["-p", profile, "--", nodeBin, "--experimental-strip-types", pitInnerScript, ...piArgs],
  { stdio: "inherit", env, cwd },
);
```

### 3. Unify Launch Path in launchEffect

**Purpose:** Replace in-process `main()` call with spawned `inner.ts` for non-sandbox mode.

**Changes:**

#### pit/src/launcher/index.ts

**Remove imports** (only inner.ts needs these now):
```typescript
// DELETE these lines:
import { main } from "@earendil-works/pi-coding-agent";
import { createExtensionFactories } from "../extensions/index.ts";
```

**Replace** the non-sandbox branch in `launchEffect()`:

**Before:**
```typescript
// Non-sandbox: pass the same factories so extension behaviour is consistent.
// Also pass nonSandboxExtensions from pit config as --extension flags.
const socketPath = escapeHandle?.socketPath ?? "";
const token = escapeHandle?.token ?? "";
const extFlags = nonSandboxExtensionFlags(pitConfig);
process.chdir(cwd);
yield* Effect.promise(() =>
  main([...piArgs, ...extFlags], {
    extensionFactories: createExtensionFactories(socketPath, token, false),
  }).catch(() => {})
);
```

**After:**
```typescript
// Non-sandbox: spawn inner.ts directly (no bwrap/sandbox-exec wrapper)
const scriptPath = process.argv[1]!;
const innerScript = resolve(dirname(scriptPath), "src", "launcher", "inner.ts");

const childEnv: Record<string, string | undefined> = {
  ...process.env,
  PIT_ESCAPE_SOCKET: escapeHandle?.socketPath ?? "",
  ...(escapeHandle?.token ? { PIT_ESCAPE_TOKEN: escapeHandle.token } : {}),
  // NOTE: PIT_SANDBOXED is NOT set → sandboxed=false in inner.ts
};

const extFlags = nonSandboxExtensionFlags(pitConfig);

const child = spawn(
  process.execPath,
  ["--experimental-strip-types", innerScript, ...piArgs, ...extFlags],
  { stdio: "inherit", cwd, env: childEnv }
);

// Forward signals and wait for child exit
const sigterm = () => { try { child.kill("SIGTERM"); } catch { /* gone */ } };
const sigint  = () => { try { child.kill("SIGINT");  } catch { /* gone */ } };
process.on("SIGTERM", sigterm);
process.on("SIGINT",  sigint);

yield* Effect.promise(() => new Promise<void>((resolve, reject) => {
  child.on("error", (err) => {
    process.off("SIGTERM", sigterm);
    process.off("SIGINT",  sigint);
    reject(err);
  });
  child.on("exit", (code) => {
    process.off("SIGTERM", sigterm);
    process.off("SIGINT",  sigint);
    if (code !== 0 && code !== null) {
      process.exit(code);
    }
    resolve();
  });
}));
```

**Note:** `nonSandboxExtensionFlags` is still needed to pass pit config extensions via CLI args.

### 4. Update Tests

#### pit/src/launcher/inner.test.ts

**Add tests** for PIT_SANDBOXED handling:
```typescript
it("sets sandboxed=true when PIT_SANDBOXED=1", async () => {
  const { mainOpts } = await run({ PIT_SANDBOXED: "1", PIT_ESCAPE_SOCKET: "s" });
  // Check that createExtensionFactories was called with sandboxed=true
  // This requires mocking createExtensionFactories or inspecting the factories
});

it("sets sandboxed=false when PIT_SANDBOXED is absent", async () => {
  const { mainOpts } = await run({ PIT_ESCAPE_SOCKET: "s" });
  // Check that createExtensionFactories was called with sandboxed=false
});
```

#### pit/src/launcher/index.test.ts

**Update tests** to check for PIT_SANDBOXED in bwrap args:
```typescript
it("includes PIT_SANDBOXED=1 in setenv list", () => {
  const pairs = setenvPairs(launch({}));
  expect(pairs["PIT_SANDBOXED"]).toBe("1");
});
```

**Add test** for non-sandbox spawn path:
```typescript
it("non-sandbox mode spawns inner.ts without PIT_SANDBOXED", () => {
  // Mock spawn and verify:
  // - inner.ts is spawned
  // - PIT_SANDBOXED is NOT in env
  // - PIT_ESCAPE_SOCKET and PIT_ESCAPE_TOKEN are set if escapeHandle provided
});
```

---

## Future Work: Simplify Mount Spec (macOS-style for both platforms)

> **Status:** Deferred (separate PR)

### Current State

**Linux (bwrap):** default-deny model
- Empty tmpfs at `/`
- Explicit ro-bind for each allowed path (/usr, /etc, /lib, /nix, etc.)
- Platform-specific mount lists (linuxPlatformRoMounts)

**macOS (sandbox-exec):** default-allow-reads model
- `(allow file-read*)` in SBPL profile
- Explicit deny for credentials (~/.ssh, ~/.aws, etc.)
- Simpler, more flexible

### Proposed Change

Make Linux match macOS: read everything, deny credentials.

**Benefits:**
- Eliminates platform-specific mount logic
- No need for linuxPlatformRoMounts()
- Works with any tool installation location
- One mental model for both platforms

**Implementation:**

#### pit/src/launcher/index.ts (bwrapLaunch)

Replace the tmpfs + explicit ro-bind approach:
```bash
# Current (many ro-bind entries):
--tmpfs /
--ro-bind /usr /usr
--ro-bind /etc /etc
--ro-bind /lib /lib
...

# New (single ro-bind):
--ro-bind / /              # mount entire filesystem read-only
--bind /worktree /worktree  # override specific paths as read-write
```

#### pit/src/core/sandbox/pure.ts (buildSandboxMountSpec)

**Remove:**
- `linuxPlatformRoMounts()` function
- Platform-specific ro lists
- The `platform` parameter (no longer needed)

**Add:** readDeny for Linux (same credential denylist as macOS):
```typescript
const DEFAULT_READ_DENY = [
  "~/.ssh",
  "~/.aws",
  "~/.gnupg",
  "~/.config/gh",
  "~/.config/gcloud",
  "~/.azure",
  "~/.config/op",
  "~/.netrc",
];
```

**Implement deny via tmpfs overlay:**
```bash
--tmpfs ~/.ssh    # hide real .ssh with empty dir
--tmpfs ~/.aws
...
```

**Result:** Both platforms use the same model:
- Read everything by default
- Write only specific paths (worktree, /tmp, agentDir, etc.)
- Deny specific credential paths

### Why Deferred

This is a larger refactor that changes the security model. It should be:
1. Discussed separately (security implications)
2. Tested thoroughly (credential deny mechanism)
3. Implemented in a follow-up PR

The current plan (unify inner.ts + buildSandboxEnv) is already a significant improvement and can land independently.

---

## Migration Checklist

- [ ] Add PIT_SANDBOXED env var
- [ ] Update inner.ts to read PIT_SANDBOXED
- [ ] Create buildSandboxEnv() function
- [ ] Update bwrapLaunch() to use buildSandboxEnv()
- [ ] Update sbplLaunch() to use buildSandboxEnv()
- [ ] Remove buildSealedEnv() and allowedEnvArgs()
- [ ] Update launchEffect() non-sandbox path to spawn inner.ts
- [ ] Remove unused imports from index.ts (main, createExtensionFactories)
- [ ] Update inner.test.ts with PIT_SANDBOXED tests
- [ ] Update index.test.ts with PIT_SANDBOXED and non-sandbox spawn tests
- [ ] Test on Linux (bwrap)
- [ ] Test on macOS (sandbox-exec)
- [ ] Test non-sandbox mode (pit --no-sandbox)

---

## Testing Strategy

1. **Unit tests** for buildSandboxEnv()
   - Verify PIT_SANDBOXED=1 is set
   - Verify PATH is forwarded from host
   - Verify platform-specific paths are removed

2. **Integration tests** for launchEffect()
   - Non-sandbox mode spawns inner.ts
   - Sandbox mode wraps inner.ts with bwrap/sandbox-exec
   - Both paths produce same pi session behavior

3. **Manual testing**
   - Run pit in sandbox mode (Linux + macOS)
   - Run pit --no-sandbox
   - Verify extensions load correctly
   - Verify proxy env vars are respected
   - Verify escape socket works

---

## Success Criteria

- [ ] Both sandbox and non-sandbox paths use inner.ts
- [ ] No duplicate env var handling logic
- [ ] PATH is forwarded from host (no hardcoded platform paths)
- [ ] Tests pass on Linux and macOS
- [ ] No regression in existing functionality
- [ ] Code is simpler and easier to maintain

---

## Notes

- **PIT_SANDBOXED vs PIT_IS_INNER:** We removed PIT_IS_INNER (dead code) and added PIT_SANDBOXED with clear semantics.
- **PATH forwarding:** Simplifies code and works with any package manager. The agent will use whatever PATH the user has configured.
- **Mount simplification:** Deferred to avoid scope creep. The current plan already reduces complexity significantly.
- **Security:** No changes to security model in this plan. The mount simplification (if adopted) would be a separate security discussion.
