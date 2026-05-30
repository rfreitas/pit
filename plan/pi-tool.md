# pi-tool

## Problem

Agent-written bash scripts can't call pi tools. `subagent` needs the pi
runtime. In sandboxed environments (e.g. pit), `/usr/bin/git` is blocked but
the `git` tool registered by the host extension works fine — scripts have no
way to reach it. No composable escape hatch exists.

## Solution

A general Pi extension that runs a unix socket server and a `pi-tool` CLI
shim that talks to it. Agent scripts call `pi-tool`, the extension dispatches
to whatever tools are registered in the session and returns JSON on stdout.

Works in vanilla pi (subagent, custom tools) and in pit (additionally exposes
pit's git tool, which routes through pit's escape server automatically).

## Architecture

### Extension (`packages/pi-tool/`)
- On `session_start`:
  - Scans `.pi/tool-*.sock` files, checks each pid with `kill -0` — removes
    stale sockets from crashed sessions
  - Inspects all registered tools for `shim` metadata (see shim convention
    below), creates symlinks `pi-tool → <binary>` for each in `.pi/bin/`
  - Writes `pi-tool` shim to `<worktree>/.pi/bin/pi-tool` (shared, stateless)
  - Starts unix socket server at `<worktree>/.pi/tool-<sessionId>-<pid>.sock`
- Intercepts every `bash` tool_call, prepends env vars so scripts get them
  automatically
- Receives requests over the socket, dispatches to real tool implementations,
  returns result
- On `session_shutdown`: removes own socket and shim symlinks

### CLI shim (`pi-tool`)
- Written to `.pi/bin/pi-tool` at session start — shared across all sessions
  in the worktree, stateless (reads `PI_TOOL_SOCK` from env)
- Detects how it was invoked via `$0`:
  - `pi-tool` → generic mode: JSON/positional input, JSON output
  - e.g. `git` (via symlink) → shadow mode: positional-only, raw text output,
    exit code mirrors native binary
- Connects to `PI_TOOL_SOCK`, sends request, blocks for response, exits

### Socket lifecycle
- Path: `<worktree>/.pi/tool-<sessionId>-<pid>.sock`
- `sessionId` is stable (from session file header) — unique per session file
- `pid` disambiguates multiple pi instances on the same session file
- Stale sockets cleaned at `session_start` via `kill -0 <pid>` on filename
- Own socket removed at `session_shutdown`; crashes leave stale sockets that
  are cleaned on next startup

### Environment injection
Prepended to every `bash` tool_call automatically:
```bash
export PI_TOOL_SOCK=<worktree>/.pi/tool-<sessionId>-<pid>.sock
export PATH=<worktree>/.pi/bin:$PATH
```

### Tools exposed
All tools are exposed. Scripts can call any tool including builtins
(`read`, `write`, `edit`, etc.) — redundant but harmless. No blacklist to
maintain.

### Session isolation
Each session's extension instance creates its own socket and injects its own
`PI_TOOL_SOCK`. Subagent sessions (spawned in-process via `createAgentSession`)
load the extension fresh and get their own socket — tools dispatched in a
subagent session operate on that session's context, not the parent's.

### Shim convention

Tools can optionally declare metadata so `pi-tool` shadows their native binary:

```typescript
pi.registerTool({
  name: "git",
  shim: {
    binary: "git",              // creates .pi/bin/git → pi-tool symlink
    positional: true,            // only supports positional (args) mode
    tty: false,                  // TUI/interactive commands are blocked
  },
  parameters: Type.Object({
    args: Type.Array(Type.String()),
  }),
  execute: ...,
});
```

**Rules:**
- Only tools with a single required `string[]` parameter can be shimmed
- `shim.binary` must match an existing system binary the agent might reach for
- `shim.tty: false` means interactive/TUI subcommands are detected and blocked
  with a clear error (e.g. `"git log opens a pager. Use git log --no-pager"`)
- Multiple extensions registering the same `shim.binary` — first-loaded wins
  (pi's tool collision rule: first registration per name wins, no suffix)
- Shadowed tools get raw text output (mimics the native binary), not the JSON
  envelope used by `pi-tool <tool>`
- If `$0` is `pi-tool` (not a symlink), `shim` metadata is ignored — normal
  JSON/positional/JSON-output behaviour applies

## CLI

Two invocation modes, detected via `$0`:

```
pi-tool <tool> [args]        # generic mode
<binary> [args]               # shadow mode (via symlink pi-tool → <binary>)
pi-tool --list
pi-tool --describe <tool>
pi-tool --help
```

### Output

**Generic mode** (`$0 = pi-tool`) — always a JSON object, predictable
regardless of tool or runtime state:

```json
{ "ok": true,  "content": "On branch main...", "details": {} }
{ "ok": false, "content": "fatal: not a git repo", "details": {}, "error": "tool execution failed" }
```

`content` is `content[]` text blocks joined as a string. `details` is the
tool's raw details object passed through verbatim (empty object if none).

```bash
result=$(pi-tool git -- status | jq -r .content)
```

**Shadow mode** (`$0 = git` via symlink) — raw text output mimicking the
native binary. Exit codes mirror the tool's native behaviour.

```bash
# shadowed: looks and behaves exactly like real git
git status
git commit -m "fix"
git diff HEAD~1
```

Shadowed tools do not accept JSON input (stdin forwarded untouched to the
tool). Interactive/TUI subcommands are blocked with a descriptive error:

```
git log
→ "git log opens a pager. Use git log --no-pager instead"

git add -p
→ "interactive git commands are not supported in sandbox mode"

git push
→ "git push is not permitted. Allowed: add, commit, diff, log, merge, rebase, reset, show, stash, status"
```

Streaming (`onUpdate` content) is forwarded to stdout incrementally in both modes.

### Input (generic mode only)

Input is read from stdin and branched on shape:

```
stdin received
  │
  ├── valid JSON object  →  JSON mode
  │     validate against schema (TypeBox)
  │     report field errors if invalid
  │
  └── anything else      →  positional mode
        schema has one required key, type string    →  join args as string
        schema has one required key, type string[]  →  split args as array
        anything else  →  error with full schema + generated jq example
```

**JSON mode** — primary mode for structured tools:

```bash
# static
echo '{"agent":"reviewer","task":"review src/"}' | pi-tool subagent

# dynamic args via jq — no quoting issues
jq -n --arg agent "reviewer" --arg task "review $path" \
  '{agent:$agent,task:$task}' | pi-tool subagent
```

**Positional mode** — for tools with a single required `string` or `string[]`
parameter. Optional fields do not disqualify positional mode.

```bash
pi-tool git status
pi-tool git commit -m "fix: thing"
# or, if shimmed: git status (same result, raw text output)
```

**Error messages** (generic mode) include the full schema and a generated `jq`
invocation:

```
Error: tool 'subagent' requires structured input.

Schema:
  agent  string  (required)  Agent name to delegate to
  task   string  (required)  Task for the agent to perform

Usage:
  jq -n --arg agent "..." --arg task "..." '{agent:$agent,task:$task}' | pi-tool subagent
```

Shadowed tools give sandbox-aware errors (see Output section above).

### Exit codes (generic mode)

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Tool execution error |
| 2 | CLI usage error (bad args, unknown tool) |
| 3 | Socket error (pi not running, timeout) |

Shadow mode mirrors the tool's native exit codes exactly.

### Streaming

Both modes support streaming. Content is forwarded directly to stdout (raw
text in shadow mode, JSON-lines in generic mode):

```bash
# generic mode
echo '{"agent":"builder","task":"build and test"}' | pi-tool subagent --stream
# {"type":"update","content":"Planning..."}
# {"type":"result","ok":true,"content":"Done.","details":{}}

# shadow mode (git log streams incrementally, like real git)
git log --no-pager
```

Without `--stream`, blocks silently until complete.

### Discovery

```bash
pi-tool --list              # all exposed tools with descriptions
pi-tool --describe subagent # full input schema for a tool
```

## Examples

```bash
# shadowed git — invisible, feels native
git add .
git commit -m "checkpoint"
git status | grep "nothing to commit"

# error handling on shadowed tool
if ! git commit -m "auto"; then
  echo "commit failed" >&2
  exit 1
fi

# generic mode — delegate to subagent, capture output
summary=$(
  jq -n --arg task "summarise src/" '{agent:"summariser",task:$task}' \
  | pi-tool subagent \
  | jq -r .content
)
echo "$summary" > SUMMARY.md

# stream progress
echo '{"agent":"builder","task":"build and test"}' | pi-tool subagent --stream
```

## Testing

All tests run in CI. No LLM, no `pi` CLI install — tests use the SDK directly
(`@earendil-works/pi-coding-agent` is already in `node_modules`). Tool
implementations are mocked via `customTools` so dispatch logic is testable
without real subagent, real git, or real anything.

Tests co-located in `packages/pi-tool/src/`. Framework: vitest (consistent
with the rest of the repo).

### Unit — pure functions, no pi session

- **Input parser**
  - Valid JSON object → JSON mode
  - JSON primitive / array / invalid → positional mode
  - Positional: single required `string` key → join as string
  - Positional: single required `string[]` key → split as array
  - Positional: multi-key required schema → error with schema + jq example
  - Optional fields do not disqualify positional mode
  - TypeBox field errors surfaced correctly for malformed JSON objects

- **Error message generator**
  - Produces correct schema listing from TypeBox schema
  - Generates correct `jq` invocation for all-string required fields
  - Handles mixed types (string + number) gracefully

- **Output serializer**
  - `TextContent[]` joined correctly
  - `ImageContent` blocks handled (dropped or noted)
  - `details` passed through verbatim
  - `isError` → `ok: false`

- **Stale socket cleanup**
  - Files matching `tool-*.sock` pattern parsed for pid
  - `kill -0` success → file kept
  - `kill -0` failure → file removed
  - Non-matching files in `.pi/` untouched

### Integration — SDK session, no LLM

Uses `createAgentSession({ customTools, sessionManager: SessionManager.inMemory() })`.
Tools are mocked — dispatch logic is fully exercised without real implementations.

- **Lifecycle**
  - Socket created at `session_start`, path matches `tool-<sessionId>-<pid>.sock`
  - Shim written to `.pi/bin/pi-tool`, is executable
  - Tools with `shim` metadata → symlinks created (e.g. `.pi/bin/git → pi-tool`)
  - Socket and symlinks removed at `session_shutdown`
  - Two sessions in same worktree get distinct socket paths

- **Environment injection**
  - `bash` tool_call has `PI_TOOL_SOCK` and `PATH` prepended
  - Non-bash tool_calls are not modified

- **Dispatch — generic mode**
  - JSON input → correct tool called with correct params → JSON output
  - Positional input (`string[]` tool) → correct params → JSON output
  - `ok: true`, `content` matches mock return, `details` passed through

- **Dispatch — shadow mode**
  - Invoked as `git` → positional-only, raw text output, correct exit code
  - Stdin forwarded untouched (no JSON parsing)
  - TUI subcommands blocked with descriptive error
  - Unauthorized subcommands blocked with allowed list

- **Dispatch — errors**
  - Unknown tool → `ok: false`, exit code 2, schema on stderr
  - Tool throws → `ok: false`, exit code 1
  - Tool returns `isError: true` → `ok: false`, exit code 1
  - Missing required field → TypeBox error on stderr, exit code 2
  - Positional on multi-key tool → schema + jq example on stderr, exit code 2

- **Concurrency**
  - Two simultaneous `pi-tool` calls → both complete, correct results, no interleaving

- **Streaming**
  - Generic mode `--stream` → JSON-lines emitted as `onUpdate` fires
  - Shadow mode `--stream` → raw text forwarded as `onUpdate` fires
  - Final result line matches full result
  - Without `--stream` → blocks, single output

- **Discovery**
  - `--list` → lists all registered tools with descriptions
  - `--describe <tool>` → correct schema output
  - `--list` reflects live tool set (tool registered after startup appears)

### Manual smoke tests

Not automated — run against real environments:

- pit: `pi-tool git -- status` routes through pit escape server correctly
- pit: agent writes a script using `pi-tool git`, script runs in sandbox
- subagent: real LLM subagent spawned and result returned over socket
