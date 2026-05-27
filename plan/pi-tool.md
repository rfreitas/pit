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
  - Writes `pi-tool` shim to `<worktree>/.pi/bin/pi-tool` (shared, stateless)
  - Starts unix socket server at `<worktree>/.pi/tool-<sessionId>-<pid>.sock`
- Intercepts every `bash` tool_call, prepends env vars so scripts get them
  automatically
- Receives requests over the socket, dispatches to real tool implementations,
  returns JSON result
- On `session_shutdown`: removes own socket

### CLI shim (`pi-tool`)
- Written to `.pi/bin/pi-tool` at session start — shared across all sessions
  in the worktree, stateless (reads `PI_TOOL_SOCK` from env)
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

## CLI

```
pi-tool <tool> [args]
pi-tool --list
pi-tool --describe <tool>
pi-tool --help
```

### Input

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
```

**Error messages** include the full schema and a generated `jq` invocation:

```
Error: tool 'subagent' requires structured input.

Schema:
  agent  string  (required)  Agent name to delegate to
  task   string  (required)  Task for the agent to perform

Usage:
  jq -n --arg agent "..." --arg task "..." '{agent:$agent,task:$task}' | pi-tool subagent
```

### Output

Always a JSON object — predictable regardless of tool or runtime state:

```json
{ "ok": true,  "content": "On branch main...", "details": {} }
{ "ok": false, "content": "fatal: not a git repo", "details": {}, "error": "tool execution failed" }
```

`content` is `content[]` text blocks joined as a string. `details` is the
tool's raw details object passed through verbatim (empty object if none).

```bash
result=$(pi-tool git -- status | jq -r .content)
```

Stderr carries human-readable diagnostics only — never mixed with result content.

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Tool execution error |
| 2 | CLI usage error (bad args, unknown tool) |
| 3 | Socket error (pi not running, timeout) |

### Streaming

```bash
echo '{"agent":"builder","task":"build and test"}' | pi-tool subagent --stream
```

Emits JSON-lines until complete:

```
{"type":"update","content":"Planning..."}
{"type":"result","ok":true,"content":"Done.","details":{}}
```

Without `--stream`, blocks silently until complete.

### Discovery

```bash
pi-tool --list              # all exposed tools with descriptions
pi-tool --describe subagent # full input schema for a tool
```

## Examples

```bash
# git in a sandboxed script
pi-tool git add .
pi-tool git commit -m "checkpoint"

# delegate to subagent, capture output
summary=$(
  jq -n --arg task "summarise src/" '{agent:"summariser",task:$task}' \
  | pi-tool subagent \
  | jq -r .content
)
echo "$summary" > SUMMARY.md

# stream progress
echo '{"agent":"builder","task":"build and test"}' | pi-tool subagent --stream

# error handling
if ! pi-tool git -- commit -m "auto" | jq -e .ok > /dev/null; then
  echo "commit failed" >&2
  exit 1
fi
```
