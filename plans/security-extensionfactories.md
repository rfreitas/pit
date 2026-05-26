# Plan: pit wraps pi (extensionFactories approach)

## Core idea

Instead of bwrapLaunch exec'ing the pi binary, it exec's pit itself. The inner
pit process detects it is running inside bwrap, reads the token, and calls
`main(argv, { extensionFactories })` from the pi SDK directly. Extensions are
plain ESM arrow functions that close over `socketPath` and `token` — no token
delivery mechanism needed inside the sandbox.

## Inner pit entry point: `pit/src/inner.ts`

A dedicated 20-line file, not shared with the outer program path:

```ts
import * as undici from "undici";
import { main, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { deletePitEscapeToken, deletePitIsInner } from "./env.ts";
import { createExtensionFactories } from "./extensions/index.ts";

// Replicate what the pi binary does before calling main()
process.title = "pi";
process.emitWarning = () => {};
undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent({
  allowH2: false, bodyTimeout: 300_000, headersTimeout: 300_000,
}));
undici.install?.();

// Read and delete env vars before any child is spawned
deletePitIsInner();
const token = process.env.PIT_ESCAPE_TOKEN ?? "";
deletePitEscapeToken();
const socketPath = process.env.PIT_ESCAPE_SOCKET ?? "";

const factories: ExtensionFactory[] = socketPath
  ? createExtensionFactories(socketPath, token)
  : [];

await main(process.argv.slice(2), { extensionFactories: factories });
```

## `pit/src/pit.ts` — detect inner mode at the top

```ts
if (process.env.PIT_IS_INNER === "1") {
  await import("./inner.ts");   // inner.ts handles its own lifecycle
} else {
  // existing Effect.runPromise(program...) path
}
```

## `bwrapLaunch` changes

Target changes from pi binary to pit's inner entry point:

```ts
// Before:
const piScript = realpathSync(execSync("which pi", ...));
"--", nodeBin, piScript, ...piArgs

// After:
const pitInnerScript = resolve(dirname(process.argv[1]), "src", "inner.ts");
"--", nodeBin, "--experimental-strip-types", pitInnerScript, ...piArgs
```

Additional `--setenv` entries in the bwrap args:
```ts
"--setenv", "PIT_IS_INNER", "1",
"--setenv", "PIT_ESCAPE_TOKEN", token,
// PIT_ESCAPE_SOCKET already in env whitelist
```

## `extensionArgs()` — deleted

No `--extension` flags for pit's own extensions. The factory aggregator replaces it:

```ts
// pit/src/extensions/index.ts
export const createExtensionFactories = (
  socketPath: string,
  token: string,
): ExtensionFactory[] => [
  createReloadHook(socketPath, token),
  createGitTool(socketPath, token),
  createMergeCommand(socketPath, token),
  createLocDiffStatus(socketPath, token),
  createMergeStatus(socketPath, token),
  createRenameBranchCommand(socketPath, token),
];
```

## Extension files — factory pattern

Each extension changes from:
```ts
export default function (pi: ExtensionAPI) {
  const socketPath = process.env.PIT_ESCAPE_SOCKET;
  if (!socketPath) return;
  // ...register using socketPath
}
```
To:
```ts
export const createReloadHook = (
  socketPath: string,
  token: string,
): ExtensionFactory => (pi) => {
  // ...register using socketPath and token (closure vars)
};
```

Internal logic is unchanged. `sendEffect(socketPath, token, req)` gains the
token as a direct parameter — no module singleton, no env var read.

`helpers.ts` (useEscapeStatus) gains `token: string` as a second parameter.

## Non-sandbox path

`launchEffect` non-sandbox path calls main() directly with factories — identical
to the inner sandbox path, just without bwrap:

```ts
// non-sandbox in launchEffect:
yield* Effect.promise(() =>
  main(piArgs, {
    extensionFactories: socketPath ? createExtensionFactories(socketPath, token) : [],
  }).catch(() => {})
);
```

`launchEffect` gains `socketPath?: string` and `token?: string` parameters.

## `env.ts` additions

```ts
export const setPitIsInner = (): void    => { process.env.PIT_IS_INNER = "1"; };
export const deletePitIsInner = (): void => { delete process.env.PIT_IS_INNER; };
export const setPitEscapeToken = (t: string): void => { process.env.PIT_ESCAPE_TOKEN = t; };
export const deletePitEscapeToken = (): void       => { delete process.env.PIT_ESCAPE_TOKEN; };
```

## `program.ts` changes

- Remove `extensionArgs()` import and all its call sites (removed from piArgs)
- `startPitEscapeEffect` returns `Option<{ socketPath, token }>`
- Socket path extracted via `setPitEscapeSocket(handle.socketPath)` (already exists)
- Token threaded to `launchEffect`

## The module resolution problem

**This is the critical constraint.** Pit source files live at
`~/repos/agent/pit/src/`. Node.js ESM resolves imports from that location
upward to `~/repos/agent/node_modules/`. That path is not in the selective home
mounts.

**NODE_PATH does not work for ESM** (it is a CJS-only fallback). `--chdir` to
the worktree does not help (resolution follows the source file, not cwd).

**Three options:**

| Option | Description | Cost |
|---|---|---|
| A | Keep full `--ro-bind $HOME $HOME` | Drops selective home mount protection (V3) |
| B | Add `~/repos/agent/node_modules` as explicit `--ro-bind` | 368 MB; one extra bind arg; no credentials exposed |
| C | Compile `inner.ts` + extension factories into a single bundled JS file placed in `nodeDir/bin` | Build step needed; resolves from nodeDir (already mounted); cleanest at runtime |

**Recommended: Option B** for now. `~/repos/agent/node_modules` contains no
credentials. Adding one `--ro-bind` for it is targeted and explicit. Option C
is the right long-term answer but adds build infrastructure.

`bwrapLaunch` resolves it as:
```ts
const pitNodeModules = resolve(dirname(dirname(process.argv[1])), "node_modules");
// --ro-bind pitNodeModules pitNodeModules
```

The pit source directory itself (`~/repos/agent/pit`) also needs mounting:
```ts
const pitDir = resolve(dirname(process.argv[1]));
// --ro-bind pitDir pitDir
```

These two mounts are **not credentials** — they are source code and development
dependencies. Adding them is safe.

## Bootstrap stability check (proposed skill)

Pit replicates 4 lines from the pi binary before calling main(). If those lines
change in a pi update, pit must be updated to match.

A skill should:
1. Extract the bootstrap preamble from the installed pi binary (`cli.js`)
2. Compare against what inner.ts does
3. Surface a diff if they diverge

The bootstrap has been stable across 0.74.0 → 0.75.5 (verified). The check
only needs to run when `pi update` is called or during CI.

## Files changed

| File | Change |
|---|---|
| `pit/src/inner.ts` | new — inner-mode entry point |
| `pit/src/pit.ts` | add inner-mode branch at top |
| `pit/src/launcher.ts` | bwrapLaunch target = inner.ts; launchEffect gains socketPath/token; startPitEscapeEffect returns EscapeHandle; delete extensionArgs() |
| `pit/src/program.ts` | remove extensionArgs() call sites; thread token to launchEffect |
| `pit/src/env.ts` | add 4 env mutation helpers |
| `pit/src/extensions/index.ts` | new — factory aggregator |
| 6 extension files | factory pattern |
| `pit/src/extensions/status/helpers.ts` | add token param to useEscapeStatus |

Plus the env-whitelist and selective home mount changes from
`plans/security-escape-hardening.md` Layer 2 (unchanged).

---

# Comparison: extensionFactories approach vs token.ts approach

## Token delivery

| | token.ts (old) | extensionFactories (new) |
|---|---|---|
| Delivery mechanism | fifo → IIFE → module singleton | env var → closure capture |
| /proc exposure | none (fifo) | brief /proc/environ during bwrap setup |
| Ordering constraint | none (fifo self-destructs) | env var deleted before main() — synchronous, safe |
| Complexity | high: fifo + libuv thread + module singleton | low: env var + function parameter |
| Test surface | IIFE side effects, module caching, jiti CJS | plain function parameter |

The extensionFactories approach trades a theoretical /proc/environ window (token
is set by bwrap's --setenv and deleted before main() runs — no user code or
bash children run in that gap) for massive simplification.

## Extension architecture

| | token.ts (old) | extensionFactories (new) |
|---|---|---|
| Extension loading | jiti CJS (--extension path) | pi SDK extensionFactories (ESM closures) |
| Token access | getEscapeToken() from module singleton | closure variable |
| socketPath access | process.env.PIT_ESCAPE_SOCKET | closure variable |
| CJS/ESM boundary | yes — barrel import restriction in extensions | no — plain ESM |
| Barrel import restriction | yes | no |
| Test pattern | mock process.env + module singletons | pass socketPath/token directly |
| Contributor convention | non-standard (CJS extensions with singleton) | standard ESM functions |

## Mounts required

| | token.ts (old) | extensionFactories (new) |
|---|---|---|
| Extension files mounted | yes (~/repos/agent/pit/src/extensions/) | no (closures, no filesystem) |
| pit binary mounted | no (exec pi, not pit) | yes (~/repos/agent/pit/) |
| pit node_modules mounted | yes (same resolution issue) | yes (same resolution issue) |
| Difference | none — both need pit dir + node_modules | none |

**This is a key finding**: both approaches require the same mounts. The home
directory dependency is NOT eliminated by either approach — it's inherent to pit
living at ~/repos/agent/pit/ and resolving from ~/repos/agent/node_modules.

## Bootstrap

| | token.ts (old) | extensionFactories (new) |
|---|---|---|
| What is exec'd | pi binary (self-contained) | pit source + bootstrap replication |
| Bootstrap drift risk | none | 4 lines that could diverge from pi |
| Mitigated by | n/a | skill that diffs cli.js bootstrap |

## Other

| | token.ts (old) | extensionFactories (new) |
|---|---|---|
| piScript path | which pi (globally installed, always mounted) | process.argv[1] + src/inner.ts |
| check-no-disable | IIFE side effect needs scoped exception | no exceptions needed |
| No-sandbox path | env var + delete (via env.ts) | same as sandbox (call main() with factories) |
| Structural separation | inner vs outer pit identical | inner and outer are clearly different code paths |

---

# Self-grill

**1. The /proc/environ window for PIT_ESCAPE_TOKEN**
With extensionFactories, token is set via `--setenv PIT_ESCAPE_TOKEN token` by
bwrap. It appears in `/proc/[pid]/environ` of the inner pit process from the
moment it starts until `deletePitEscapeToken()` is called in inner.ts. That gap
is the first few microseconds of startup before any JS runs — effectively zero.
BUT: the token is also visible in `/proc/[inner-bwrap-pid]/cmdline` of the bwrap
process? No — `--setenv` sets environment, not argv. It does NOT appear in the
bwrap cmdline. ✓ Fine.

**2. Are extensionFactories actually loaded after --extension files?**
Confirmed: `loadExtensions(paths)` runs first, then `loadExtensionFactories()`.
If a user installs an extension that registers a conflicting tool name, pit's
factories would lose (earlier registration wins in pi). Acceptable — pi handles
conflicts with diagnostics.

**3. Does inner.ts correctly handle the session picker flow?**
The session picker (`pit -r`) runs in the OUTER process, shows the TUI, then
calls `launchEffect` with `--session selectedPath` in piArgs. bwrapLaunch execs
inner.ts with those piArgs. inner.ts calls `main([..., "--session", path, ...])`.
pi opens the session correctly. ✓

**4. What if there is no escape server (main worktree, non-linked)?**
`startPitEscapeEffect` returns None. socketPath = "", token = "". bwrapLaunch
does not set `PIT_ESCAPE_TOKEN` (empty string) and does not create factories.
inner.ts gets empty factories. pi runs without pit's extensions. ✓

**5. Does `undici` need to be imported differently inside bwrap?**
`undici` is a dependency of pi-coding-agent, available in nodeDir/lib/node_modules
which IS mounted. But inner.ts is in pit's source tree, which resolves from
~/repos/agent/node_modules. If we add Option B mounts, ~/repos/agent/node_modules
has undici too. Either way undici is available. ✓

**6. process.title = "pi" — does this matter?**
It sets the process name visible in `ps` and `top`. Users who use `pit` would
see "pi" as the process name, not "pit". Cosmetically imperfect. Could set it
to "pit" instead, but that would diverge from pi's convention for session
management tools that grep for the process name. Low risk.

**7. The `undici.install?.()` call — what does it do?**
Ensures Node.js built-in `fetch` uses the same undici instance as the dispatcher.
Node 26+ bundles fetch separately; without this, compressed responses through
the undici dispatcher wouldn't be decompressed correctly. Important for
correctness on newer Node versions. Must not be omitted.

---

# Questions for the user

**1. Mount approach for pit's dependencies**
Option B (mount ~/repos/agent/node_modules) works but adds 368MB read-only.
Option C (bundle inner.ts) is clean but needs a build step and tooling.
Is Option B acceptable for now? Or should we build toward C immediately?

**2. Bootstrap skill scope**
The bootstrap check compares 4 lines in cli.js against inner.ts. Should this
be a passive skill (only run when asked) or an active check that runs on
`pi update` and `pit --version`?

**3. Extension contributor experience**
Pit's own extensions use the factory pattern. User-installed extensions still
use the standard pi `export default function(pi)` convention. Is the two-tier
model OK, or should we document the factory pattern as the pit extension standard?

**4. Selective home mounts — still worth doing?**
With either approach, the pit directory and its node_modules must be mounted.
This means ~/repos/agent/ is accessible (though not the entire home). The
credential files (~/repos/agent/.env, ~/repos/agent/secrets, etc.) would still
be readable if they exist there. Is the selective home mount still meaningfully
more secure than full home mount given this constraint?

**5. Non-worktree mode**
In non-worktree mode (pit -nt), there is no escape server and therefore no
token. inner.ts gets empty factories — pi runs without pit's git tool, /merge,
etc. Is that acceptable for non-worktree sessions?
