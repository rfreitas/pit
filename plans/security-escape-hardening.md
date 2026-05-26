# Plan: harden the pit-escape socket

## Problem

The escape socket is an unauthenticated privileged channel. Any process inside
the sandbox — including loaded extensions and the AI agent manipulated by a
prompt injection — can connect and issue any op: `git reset --hard`, forged
commits, `refresh-settings`.

See `plans/pit-escape-socket-security.md` for the original bypass write-up.

## Threat model

`merge-to-parent` and `rename-branch` are user-initiated slash commands. The
agent does not call them autonomously, so confirmation prompts are not needed.

Real threats:
1. A malicious or compromised npm package loaded as a pi extension
2. The AI agent manipulated into calling lower-level socket ops directly via bash

Neither is currently resisted.

## Architecture constraints (current codebase)

- `pit/scripts/check-no-disable.ts` fails the build if any `eslint-disable`
  directive exists in `pit/src/`. Zero disables are allowed.
- `functional/no-let` is **removed** from the eslint config. `let` declarations
  and variable reassignment are fine. `functional/immutable-data` still bans
  **object property** mutations (`obj.prop = x`).
- `func-style: ["error", "expression"]` requires arrow functions, not `function`
  declarations.
- `env.ts` is the established pattern for unavoidable `process.env` mutations:
  one dedicated file with a scoped `functional/immutable-data: off` override in
  `eslint.config.mjs`. All callers import a named function; no direct mutation
  outside that file.
- Extensions are loaded by pi's jiti CJS loader **sequentially** (confirmed:
  `for…await` loop in pi's extension loader). The first extension in
  `extensionArgs()` fully completes before the second starts.

## Two layers — implement in order

### Layer 1: auth token

**Server side** — `pit/src/escape/server.ts`

`startPitEscapeEffect` in `launcher.ts` generates a token with `randomUUID()`
and passes it as `argv[2]` to the escape server process (first positional arg,
before socket path). The server stores it in a module-level `const` and checks
`req.token !== token` on every request, responding `{ error: "unauthorized" }`
and closing the connection on mismatch.

Token in escape server argv is visible in `/proc/[pid]/cmdline` to other
processes with the same UID — but the escape server runs outside bwrap and is
already trusted. Not a new vector.

**Token delivery to the sandbox**

Two modes:

*Sandbox mode* (bwrap): token travels through a kernel named pipe (fifo).

```
launcher.ts
  token = randomUUID()
  mkfifo /tmp/pit-token-<pid>.fifo  (mode 600)
  writeFile(fifoPath, token, noop)  ← async; libuv thread blocks on O_WRONLY
                                       until inner process opens read end
  bwrapLaunch(... --ro-bind fifoPath /pit-token-pipe ...)
  spawnSync(bwrap)  ← main thread blocks; libuv thread runs independently
  // inner process reads /pit-token-pipe → unblocks libuv thread → write completes
  unlinkSync(fifoPath)              ← after bwrap exits
```

The fifo path appears in the bwrap `--ro-bind` arg (visible in `/proc/[pid]/cmdline`
of the outer bwrap process) but not the token content. The content lives in kernel
pipe buffers — invisible to `/proc/self/environ`, `/proc/self/cmdline`, and all
userspace tools. After the first `readFileSync` the pipe is empty.

*Non-sandbox mode* (no bwrap, `--no-sandbox`): token is set in
`process.env.PIT_ESCAPE_TOKEN` via `setPitEscapeToken()` in `env.ts` before
`main(piArgs)` is called. `token.ts` (see below) reads and deletes it on first
import, which happens during `reload.ts` loading — before the agent processes
any user request and before any bash child is spawned.

**Token module — `pit/src/extensions/escape/token.ts`** (new file)

A module-level `let _token = ""` is set once by an IIFE at module load time.
Since `functional/no-let` is removed, this is valid without any lint exception.
The `delete process.env.PIT_ESCAPE_TOKEN` mutation goes through `env.ts`.

```ts
import { readFileSync } from "node:fs";
import { deletePitEscapeToken } from "../../env.ts";

let _token = "";

export const getEscapeToken = (): string => _token;

// Runs once when the module is first required by jiti.
// reload.ts is first in extensionArgs(), so this executes before any other
// extension imports this module.
void (() => {
  try {
    // Sandbox mode: read from kernel fifo — zero /proc exposure
    const t = readFileSync("/pit-token-pipe", "utf8").trim();
    if (t) { _token = t; return; }
  } catch { /* not in sandbox or no fifo */ }
  // Non-sandbox mode: read from env var, then delete it
  _token = process.env.PIT_ESCAPE_TOKEN ?? "";
  deletePitEscapeToken();
})();
```

Jiti caches modules by resolved absolute path. All extensions that import
`token.ts` get the same cached instance, so `getEscapeToken()` returns the same
value everywhere.

**env.ts additions**

```ts
export const setPitEscapeToken = (token: string): void => {
  process.env.PIT_ESCAPE_TOKEN = token;
};
export const deletePitEscapeToken = (): void => {
  delete process.env.PIT_ESCAPE_TOKEN;
};
```

No new eslint exception needed — file already has `functional/immutable-data: off`.

**Extension callers**

Every call site that sends to the escape socket needs the token:

```ts
import { getEscapeToken } from "../escape/token.ts"; // adjust relative path

const token = getEscapeToken();
yield* sendEffect(socketPath, token, { op: "..." });
```

`sendEffect` in `escape/client.ts` gains a `token: string` second parameter
and includes it in every request body: `JSON.stringify({ ...req, token })`.

**Files changed**

| File | Change |
|---|---|
| `pit/src/launcher.ts` | `startPitEscapeEffect` returns `Option<{socketPath, token}>`, generates token, passes as argv to server; `bwrapLaunch` adds fifo creation + bind; `launchEffect` calls `setPitEscapeToken` in non-sandbox path |
| `pit/src/program.ts` | reads `pitConfig` once at top, extracts `{socketPath, token}` from escape handle, threads both to `launchEffect` |
| `pit/src/env.ts` | adds `setPitEscapeToken`, `deletePitEscapeToken` |
| `pit/src/escape/server.ts` | reads token from `argv[2]`, shifts other argv, validates on every request |
| `pit/src/extensions/escape/token.ts` | new — module singleton |
| `pit/src/extensions/escape/client.ts` | `sendEffect(socketPath, token, req)` — adds token param |
| `pit/src/extensions/hooks/reload.ts` | imports token.ts (triggers IIFE), passes `getEscapeToken()` to sendEffect |
| `pit/src/extensions/tools/git.ts` | imports `getEscapeToken`, passes to sendEffect |
| `pit/src/extensions/status/helpers.ts` | same |
| `pit/src/extensions/commands/merge/effect.ts` + `index.ts` | same |
| `pit/src/extensions/commands/rename-branch/effect.ts` + `index.ts` | same |

### Layer 2: env whitelist

`--clearenv` in `bwrapLaunch` strips the full parent environment. Only an
explicit allowlist enters the sandbox.

**Why this is safe**

- pi reads API keys from `auth.json` in `AGENT_DIR` (rw-mounted as `/pit-agent`),
  not from env vars. Confirmed by reading pi's source.
- SSH git operations go through the escape server (outside bwrap), which inherits
  the full parent env including `SSH_AUTH_SOCK`. Confirmed: `@effect/platform`
  Command executor uses `{ ...process.env, ...command.env }` when spawning.
- `--clearenv` does not break pi's auth or git functionality.

**Built-in default whitelist** (hardcoded in `bwrapLaunch`):

| Var | Why |
|---|---|
| `HOME` | git config, npm, mise |
| `PATH` | finding executables |
| `TERM` | TUI terminal capability detection |
| `LANG` | character encoding |
| `PI_CODING_AGENT` | pi's own detection flag |
| `PI_CODING_AGENT_DIR` | shadow agent dir path (when active) |
| `PIT_ESCAPE_SOCKET` | escape socket path |

**Project allowlist** — `allowEnv` in `pit/config.json`

```json
{ "denyPackages": [], "allowEnv": ["http_proxy", "https_proxy"] }
```

`allowedEnvArgs(config, env)` in `core/sandbox/pure.ts` is a pure function that
maps the list to `--setenv` pairs, skipping vars absent from the parent env.

**Files changed**

| File | Change |
|---|---|
| `pit/src/types.ts` | adds `allowEnv?: string[]` to `PitConfig` |
| `pit/src/core/sandbox/pure.ts` | adds `allowedEnvArgs` pure fn, selective home mounts |
| `pit/src/launcher.ts` | `bwrapLaunch` adds `--clearenv` + default setenv + `allowedEnvArgs` expansion; accepts `pitConfig: PitConfig` |
| `pit/config.example.json` | documents `allowEnv` field |

**Selective home mounts**

The full `--ro-bind $HOME $HOME` is replaced with specific optional mounts.
pi only needs from home: `AGENT_DIR` (explicitly rw-mounted), `~/.gitconfig`,
`~/.config/git`, `~/.npmrc`, `~/.local/share/mise/installs`. Confirmed by
reading pi's source — it reads nothing else from home.

Excluded: `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.netrc`, `~/.gnupg`.

## Not in scope

- `--unshare-ipc`: does **not** block D-Bus or abstract sockets (those are
  scoped to the network namespace, not the IPC namespace). It only isolates
  SysV IPC (shared memory, semaphores, message queues) which Node.js does not
  use. Benefit is negligible; omitted.
- `--unshare-net` + proxy: separate work; would break pi's AI API calls without
  a forwarding proxy. Deferred.
- Seccomp: high complexity, fragile with Node.js. Deferred.

## Tests

| Test location | What it covers |
|---|---|
| `pit/src/escape/server.test.ts` | rejects missing/wrong token; accepts correct token |
| `pit/src/extensions/escape/client.test.ts` | `sendEffect` includes token in request |
| `pit/src/extensions/hooks/reload.test.ts` | token read and sent on refresh-settings |
| `pit/src/core/sandbox/pure.test.ts` | `allowedEnvArgs` pure fn; selective home mounts |
| `pit/src/extensions/escape/token.test.ts` | (new) fifo read path; env fallback; delete |
| `pit/src/tests/bwrap-args.test.ts` | (new) `--clearenv` present; default vars present; `allowEnv` expansion |
