# Process Lifecycle Consistency

## Status: Plan (not yet implemented)

## Current state

`launcher.ts` manages three kinds of OS child processes, each with a different lifecycle pattern:

| Function | Pattern | Spawn API | Return |
|---|---|---|---|
| `startPitEscapeEffect` | Companion daemon | `spawn` (async) | `Effect<Option<Handle>>` |
| `bwrapLaunch` | Foreground delegation | `spawnSync` (sync, blocking) | `never` |
| `sbplLaunch` | Foreground delegation | `spawn` (async) | `Promise<never>` |

## Process tree

```
pit (parent)
 ├── pit-escape   (background daemon, unref'd, lives until pit exits)
 └── bwrap        (optional, sandboxed only)
      └── node inner.ts → main()  (the real work)
```

Or on macOS:
```
pit (parent)
 ├── pit-escape   (background daemon, unref'd)
 └── sandbox-exec (optional, sandboxed only)
      └── node inner.ts → main()
```

## Identified problem

1. **`bwrapLaunch` uses `spawnSync`** while `sbplLaunch` uses async `spawn`. There is no technical reason for this asymmetry — bwrap's `--die-with-parent` already handles cleanup on crash. The async pattern is strictly better because it allows signal forwarding.

2. **Shared signal/cleanup boilerplate** is duplicated across `startPitEscapeEffect` and `sbplLaunch` (and would be needed in a converted `bwrapLaunch`). Both register `process.on("exit")`, `process.on("SIGTERM")`, `process.on("SIGINT")` handlers that kill the child and run custom cleanup.

3. **The escape server has fundamentally different semantics** from the sandbox launchers and cannot share their lifecycle abstraction:
   - Escape server: parent does its own work (`main()` in-process), child is a sidecar
   - Sandbox launchers: parent delegates all work to child, just forwards signals

## Agreed changes

### 1. Convert `bwrapLaunch` to async `spawn` (matching `sbplLaunch`)

Replace `spawnSync` with async `spawn` + `Promise<never>`, same pattern as `sbplLaunch`. bwrap keeps `--die-with-parent` for crash defense so there's no regression.

Before:
```typescript
const result = spawnSync(bwrap, args, { stdio: "inherit" });
if (settingsPath) try { unlinkSync(settingsPath); } catch { /* already gone */ }
process.exit(result.status ?? 1);
```

After (same shape as sbplLaunch):
```typescript
const child = spawn(bwrap, args, { stdio: "inherit" });
const sigterm = () => { try { child.kill("SIGTERM"); } catch {}; process.exit(1); };
const sigint  = () => { try { child.kill("SIGINT");  } catch {}; process.exit(130); };
process.on("SIGTERM", sigterm);
process.on("SIGINT",  sigint);
return new Promise<never>((_, reject) => {
  child.on("error", reject);
  child.on("exit", (code) => {
    process.off("SIGTERM", sigterm);
    process.off("SIGINT",  sigint);
    if (settingsPath) try { unlinkSync(settingsPath); } catch {}
    process.exit(code ?? 1);
  });
});
```

### 2. Do NOT extract a shared lifecycle helper

The signal registration boilerplate (~10 lines) appears in only two places (escape server + sandbox launchers). Parameterization is tricky (does SIGTERM mean exit-the-process or just kill-the-child? does cleanup need to unlink a socket or remove a mirror dir?). The DRY tax is higher than the duplication cost at this scale.

If a third usage appears, revisit.

### 3. Do NOT treat escape server and sandbox launchers as the same pattern

They look similar (spawn + register handlers) but have fundamentally different contracts:
- **Who does the work**: parent (escape) vs. child (sandbox)
- **Who decides when to exit**: parent's `main()` returns (escape) vs. child exits (sandbox)
- **`unref()` needed**: yes (escape) vs. no (sandbox, blocks on Promise<never>)
- **Return type**: `Effect<Option<Handle>>` (escape) vs. `Promise<never>` / `never` (sandbox)

### 4. Keep `child.unref()` for escape server

Already implemented. Required so pit's event loop can drain and `process.on("exit")` can fire, which in turn kills the escape server. Without `unref()`, Node counts the child as a live handle and blocks parent exit indefinitely.

### 5. bwrap keeps `--die-with-parent`

No change needed. This is the existing crash-safety mechanism — if pit receives SIGKILL, the kernel propagates to bwrap automatically. No Node.js handler can help with SIGKILL anyway.

## Not in scope

- Self-terminating escape server (polling `process.ppid` or socket liveness). Acknowledged risk: hard crash orphans the escape server and leaks the socket file. Next pit session will `unlinkSync` the stale socket.
- Any change to the non-sandboxed code path (`main()` in-process).

## Implementation order

1. Convert `bwrapLaunch` from `spawnSync` to async `spawn` + `Promise<never>`
2. Verify signal forwarding works on both Linux (bwrap) and macOS (sandbox-exec)
3. Run full test suite (`npm test`)
4. If any regression, revert and investigate
