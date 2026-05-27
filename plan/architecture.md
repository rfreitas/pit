# pi-tool: Architecture

## Problem
Agent-written bash scripts can't call pi tools. `git` is sandboxed (real
`/usr/bin/git` hits bwrap restrictions). `subagent` needs the pi runtime.
No composable escape hatch exists.

## Solution
A `pi-tool` CLI that routes calls through a unix socket to a Pi extension,
which executes real tool implementations and returns results on stdout.

## Components

### 1. Extension (`packages/pi-tool/`)
- On `session_start`: writes `pi-tool` shim to `<worktree>/.pi/bin/pi-tool`,
  starts unix socket server at `<worktree>/.pi/tool.sock`
- Intercepts every `bash` tool_call and prepends env vars (see below)
- Receives `{ tool, args }` JSON requests over the socket
- Dispatches to real tool implementations
- Returns result as JSON over the socket

### 2. CLI shim (`pi-tool`)
- Written to `.pi/bin/pi-tool` at session start (not installed globally)
- Connects to `PI_TOOL_SOCK`, sends request, blocks for response
- See `spec-cli.md` for full interface

### 3. Socket lifecycle
- Created at `session_start`, removed at `session_shutdown`
- Path: `<worktree>/.pi/tool.sock`

### 4. Environment injection
Extension mutates every `bash` tool_call input:
```
export PI_TOOL_SOCK=<worktree>/.pi/tool.sock
export PATH=<worktree>/.pi/bin:$PATH
```
Scripts do not need to set these manually.

## Tools exposed
Non-builtin extension tools (auto-discovered via `getAllTools()`) plus `git`
(builtin but sandboxed). Default builtin tools (read, write, edit, bash, etc.)
are excluded — they work fine via filesystem ops in the sandbox.
