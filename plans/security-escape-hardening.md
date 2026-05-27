# Plan: secure the pit-escape socket

## Problem

The escape socket is unauthenticated. Any process inside the sandbox — a
malicious extension or the AI agent manipulated by prompt injection — can connect
and issue ops: `git reset --hard`, forged commits, `refresh-settings`.

The fix is an auth token. The token must be available to pit's own extensions
(so they can authenticate with the escape server) but **not to the AI agent**
(so a manipulated agent cannot forge authenticated requests).

---

## Two approaches to token delivery

The challenge is architectural: pit's extensions run inside bwrap alongside the
AI agent. Any channel that delivers the token to extensions is potentially
readable by the agent unless it is consumed before the agent starts.

### Approach A — Pi binary wrapper (extensions via jiti)

bwrap execs the pi binary. Pit's own extensions are passed as `--extension path`
flags and loaded by pi's jiti CJS loader. The token must travel from the outer
pit process into the jiti extension context without being readable by the agent.

**Token path:** outer pit → named pipe (fifo) → `token.ts` IIFE (first extension
to load) → module singleton → `getEscapeToken()` called by each extension.

The fifo is in kernel buffers — never in `/proc/environ` or `/proc/cmdline`.
After the first `readFileSync` it is empty. Subsequent extensions read from the
cached module singleton.

### Approach B — Pi API wrapper (extensions via closures)

bwrap execs pit itself. Inner pit detects it is running inside bwrap (via env
var), reads the token, then calls `main(argv, { extensionFactories })` from the
pi SDK. Extensions are plain ESM arrow functions that close over `socketPath`
and `token` — no delivery mechanism needed.

**Token path:** outer pit → `--setenv PIT_ESCAPE_TOKEN` in bwrap args → inner
pit reads and deletes immediately → passes as closure to factories.

The token is in `/proc/environ` of the inner pit process from startup until
`deletePitEscapeToken()` is called. That gap is the first microseconds of
startup, before any JS runs — effectively zero. After deletion no child process
or bash tool call can see it.

---

## Comparison

| | Approach A (pi binary wrapper) | Approach B (pi API wrapper) |
|---|---|---|
| **What bwrap execs** | pi binary (globally installed, always in `nodeDir/bin`) | pit binary (needs pit dir + node_modules mounted) |
| **Extension loading** | jiti CJS — `--extension /path/to/file.ts` | pi SDK extensionFactories — ESM closures |
| **Token delivery** | fifo → `token.ts` IIFE → module singleton | env var → deleted immediately → closure |
| **Token in `/proc`** | never (fifo content is in kernel buffers) | sub-ms window in `/proc/environ` at startup |
| **Token access by agent** | not possible — fifo drained before any extension, module singleton not in env | not possible — deleted before `main()` runs |
| **CJS/ESM boundary** | yes — barrel import restriction in extensions | none — plain ESM |
| **pi version coupling** | pit must track pi's `--extension` loader behaviour | none — pit calls `main()` directly; if pi's API changes, TypeScript catches it at compile time |
| **Bootstrap code in pit** | none — pit does not replicate pi binary preamble | 4 lines to replicate (`process.title`, `configureHttpDispatcher`, etc.) — stable across verified versions |
| **Selective home mounts** | extensions need `~/repos/agent/pit/src/` and `~/repos/agent/node_modules` mounted | same requirement for pit binary + node_modules |
| **piScript path** | `which pi` — always resolvable | `process.argv[1] + src/inner.ts` — needs pit dir mounted |
| **Test pattern** | mock `process.env` + jiti module singletons | pass `socketPath`/`token` directly to factory |
| **Extension contributor convention** | standard pi `export default function(pi)` | pit-specific factory pattern |

### Key pro for Approach B: version safety

With Approach A, pit bundles extension file paths into `--extension` args and
relies on pi's jiti loader to load them. If pi's extension loading behaviour
changes (jiti version bump, loader rewrite, API rename), extensions silently
break or behave differently without a compile-time error.

With Approach B, pit calls `main(argv, { extensionFactories })`. The
`ExtensionFactory` type is in pi's public TypeScript API. If it changes, `tsc`
fails immediately. Pit and pi stay in sync by contract, not by convention.

---

## Mount requirement (same for both approaches)

Because Approach B uses native ESM, the inner pit process resolves its imports (like `effect`) based on the physical location of `inner.ts` (`process.argv[1]`), **not** the worktree (`process.cwd()`).

- **In Production:** If `pit` is globally installed via npm, it lives in the Node global `lib/node_modules/` directory. `bwrapLaunch` *already* mounts this directory read-only. No extra mounts are needed.
- **In Development:** If `pit` is executed from source (`~/repos/agent/pit/pit.ts`), Node walks up to `~/repos/agent/node_modules/` to find dependencies. Because selective home mounts exclude the broader home directory, this dev dependency path must be explicitly mounted.

Node.js ESM resolution follows the source file location, not `cwd` or
`NODE_PATH`. The only clean solutions are:

1. Keep `--ro-bind $HOME $HOME` (current — exposes credential files)
2. Dynamically `--ro-bind` the pit directory and its closest `node_modules` ancestor.
   (targeted — neither path contains credentials, automatically handles both dev and prod)

Option 2 is recommended alongside selective home mounts. It mounts source code
and dev dependencies, not secrets.

---

## Decision: Approach B recommended

Approach B is chosen. The version safety argument is decisive: pit calling
`main()` via the public SDK API means TypeScript enforces compatibility on every
build, rather than relying on runtime jiti behaviour staying stable. The
tradeoff (4 lines of bootstrap replication, factory pattern for extensions) is
small and well-contained.

---

## Implementation

### Layer 1 — Auth token (Approach B)

#### Escape server (`pit/src/escape/server.ts`)

`startPitEscapeEffect` generates a token and passes it as `argv[2]` (before
socket path). Server validates `req.token !== token` on every request.

#### Inner pit entry point (`pit/src/inner.ts`) — new file

```ts
import * as undici from "undici";
import { main, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { deletePitEscapeToken, deletePitIsInner } from "./env.ts";
import { createExtensionFactories } from "./extensions/index.ts";

// Replicate pi binary bootstrap (stable across verified versions 0.74–0.75)
process.title = "pi";
process.emitWarning = () => {};
undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent({
  allowH2: false, bodyTimeout: 300_000, headersTimeout: 300_000,
}));
undici.install?.();

// Read and delete env vars before any child process is spawned
deletePitIsInner();
const token = process.env.PIT_ESCAPE_TOKEN ?? "";
deletePitEscapeToken();
const socketPath = process.env.PIT_ESCAPE_SOCKET ?? "";

const factories: ExtensionFactory[] = socketPath
  ? createExtensionFactories(socketPath, token)
  : [];

await main(process.argv.slice(2), { extensionFactories: factories });
```

#### `pit/src/pit.ts` — inner mode detection

```ts
if (process.env.PIT_IS_INNER === "1") {
  await import("./inner.ts");
} else {
  // existing Effect.runPromise(program...) path
}
```

#### `bwrapLaunch` in `pit/src/launcher.ts`

```ts
// Before: exec pi binary
"--", nodeBin, piScript, ...piArgs

// After: exec pit's inner entry point
const pitInnerScript = resolve(dirname(process.argv[1]), "src", "inner.ts");
"--", nodeBin, "--experimental-strip-types", pitInnerScript, ...piArgs

// Additional --setenv entries:
"--setenv", "PIT_IS_INNER", "1",
"--setenv", "PIT_ESCAPE_TOKEN", token,
// PIT_ESCAPE_SOCKET already in default whitelist

// Additional mounts for pit source + node_modules:
"--ro-bind", pitDir, pitDir,
"--ro-bind", pitNodeModules, pitNodeModules,
```

#### Extension factories (`pit/src/extensions/index.ts`) — new file

```ts
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

#### Each extension — factory pattern

```ts
// Before
export default function (pi: ExtensionAPI) {
  const socketPath = process.env.PIT_ESCAPE_SOCKET;
  if (!socketPath) return;
  // register using socketPath
}

// After
export const createGitTool = (
  socketPath: string,
  token: string,
): ExtensionFactory => (pi) => {
  // register using socketPath and token — both closure vars
};
```

#### `pit/src/env.ts` additions

```ts
export const setPitIsInner = (): void    => { process.env.PIT_IS_INNER = "1"; };
export const deletePitIsInner = (): void => { delete process.env.PIT_IS_INNER; };
export const setPitEscapeToken = (t: string): void => { process.env.PIT_ESCAPE_TOKEN = t; };
export const deletePitEscapeToken = (): void       => { delete process.env.PIT_ESCAPE_TOKEN; };
```

#### `pit/src/program.ts`

- Remove `extensionArgs()` import and all call sites
- `startPitEscapeEffect` returns `Option<{ socketPath, token }>`
- Thread token to `launchEffect`; non-sandbox path calls
  `main(piArgs, { extensionFactories })` directly

---

### Layer 2 — Env whitelist

`--clearenv` in `bwrapLaunch` strips all inherited env. Only an explicit
allowlist enters the sandbox.

**Why safe:** pi reads API keys from `auth.json` in `AGENT_DIR` (rw-mounted),
not env vars. SSH git ops go through the escape server (outside bwrap, full
parent env). `--clearenv` breaks nothing.

**Built-in default whitelist:**

| Var | Why |
|---|---|
| `HOME` | git config, npm, mise |
| `PATH` | finding executables |
| `TERM` | TUI terminal capability detection |
| `LANG` | character encoding |
| `PI_CODING_AGENT` | pi detection flag |
| `PI_CODING_AGENT_DIR` | shadow agent dir (when active) |
| `PIT_ESCAPE_SOCKET` | escape socket path |
| `PIT_IS_INNER` | inner-mode signal (deleted immediately) |
| `PIT_ESCAPE_TOKEN` | auth token (deleted immediately) |
| `http_proxy`, `https_proxy`, `no_proxy` | proxy routing for AI API calls (undici reads these) |
| `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` | uppercase proxy variants |

**Project allowlist** — `allowEnv` in `pit/config.json`:

```json
{ "denyPackages": [], "allowEnv": [] }
```

Proxy vars (`http_proxy` etc.) are in the built-in default whitelist and do not
need to be added to `allowEnv`.

**Selective home mounts** — replace `--ro-bind $HOME $HOME` with:
- `~/.gitconfig`, `~/.config/git` — git identity
- `~/.npmrc` — npm config
- `~/.local/share/mise/installs` — mise tool binaries
- `~/repos/agent/pit/` — pit source (inner.ts, extensions)
- `~/repos/agent/node_modules/` — pit's dependencies

Excluded: `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.netrc`, `~/.gnupg`.

---

### Files changed

| File | Change |
|---|---|
| `pit/src/inner.ts` | new — inner-mode entry point |
| `pit/src/pit.ts` | add inner-mode branch at top |
| `pit/src/launcher.ts` | bwrapLaunch: exec inner.ts, add token setenvs, add pit mounts; startPitEscapeEffect: generate token, return EscapeHandle; launchEffect: gains token param; delete extensionArgs() |
| `pit/src/program.ts` | remove extensionArgs() call sites; thread token to launchEffect |
| `pit/src/env.ts` | add 4 env mutation helpers |
| `pit/src/extensions/index.ts` | new — factory aggregator |
| `pit/src/extensions/hooks/reload.ts` | factory pattern |
| `pit/src/extensions/tools/git.ts` | factory pattern |
| `pit/src/extensions/status/helpers.ts` | add token param |
| `pit/src/extensions/status/merge-status.ts` | factory pattern |
| `pit/src/extensions/status/loc-diff.ts` | factory pattern |
| `pit/src/extensions/commands/merge/effect.ts` + `index.ts` | factory pattern |
| `pit/src/extensions/commands/rename-branch/effect.ts` + `index.ts` | factory pattern |
| `pit/src/types.ts` | add `allowEnv?: string[]` to `PitConfig` |
| `pit/src/core/sandbox/pure.ts` | add `allowedEnvArgs` pure fn; selective home mounts |
| `pit/config.example.json` | document `allowEnv` |

---

## Not in scope

- `--unshare-net` + proxy: breaks AI API calls without a forwarding proxy
- `--unshare-ipc`: only isolates SysV IPC — does not block D-Bus abstract sockets
- Seccomp: fragile with Node.js

## Bootstrap stability check (future skill)

inner.ts replicates 4 lines from the pi binary preamble. These have been
stable across verified versions 0.74.0 → 0.75.5. A skill should diff the
installed pi `cli.js` preamble against `inner.ts` after every `pi update`.

---

## Tests

### Philosophy

Tests assert **observable behaviour at meaningful boundaries**, not internal
implementation details. Renaming a helper or splitting a function must not
break passing tests.

### Area 1 — `bwrapLaunch` args (`pit/src/launcher.test.ts`)

Mock `node:child_process` (`spawnSync` spy) and `process.exit` so `bwrapLaunch`
runs its full production arg-building code without actually spawning bwrap.
Assert on the exact args the spy receives.

```
--clearenv present
HOME, PATH, PI_CODING_AGENT, PIT_IS_INNER in --setenv list
PIT_ESCAPE_TOKEN in --setenv when escapeToken provided, absent otherwise
PIT_ESCAPE_SOCKET in --setenv when set in env
allowEnv extras forwarded from pitConfig
--ro-bind for pitDir + pitNodeModules when script is in a local dev path
no pit --ro-bind when script path is inside global lib/node_modules
inner.ts is the exec target, not the pi binary
--experimental-strip-types flag present
```

### Area 2 — Escape server auth (`pit/src/escape/server.test.ts`)

Already integration-tests a real server over a real socket. Update `spawnEscape`
to pass token as `argv[2]`. Add token to request objects.

```
request without token   → { error: "unauthorized" }
request with wrong token  → { error: "unauthorized" }
request with correct token → op result
```

### Area 3 — Extension factories (`pit/src/extensions/index.test.ts`)

Call `createExtensionFactories("mock.sock", "mock-token")`. Invoke every
returned factory on a mock `ExtensionAPI`. Assert on **registered names and
token usage** — not on factory count (an implementation detail that changes
when extensions are added).

```
mockPi.registerTool called with { name: "git" }
mockPi.registerCommand called with "merge"
mockPi.registerCommand called with "rename-branch"
pi.on("session_shutdown") registered (reload hook)
sendEffect spy called with "mock-token" when tool/command executes
empty array returned when socketPath is empty string
```

### Area 4 — `inner.ts` bootstrap (`pit/src/inner.test.ts`)

Mock `@earendil-works/pi-coding-agent` so `main` is a spy that returns
immediately. Import and run real production `inner.ts` code.

```
PIT_ESCAPE_TOKEN deleted from process.env before main() is called
PIT_IS_INNER deleted from process.env before main() is called
main() receives process.argv.slice(2) as its first argument
main() receives non-empty extensionFactories when PIT_ESCAPE_SOCKET is set
main() receives empty extensionFactories when PIT_ESCAPE_SOCKET is empty
process.title equals "pi" before main() is called
```
