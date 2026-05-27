# pi-tool: Universal Tool Bridge

## Problem
Agent-written bash scripts can't call pi tools (git is sandboxed, subagent needs the runtime). No composable escape hatch exists.

## Solution
A `pi-tool` CLI that routes calls through a unix socket to a Pi extension, which executes real tool implementations.

## Components

### 1. Extension (`packages/pi-tool/`)
- Registers an IPC server on a unix socket at session start
- Receives `{ tool, args }` JSON requests
- Dispatches to real tool implementations
- Streams result back as JSON-lines, exits with result

### 2. CLI shim (`pi-tool`)
- Installed to a PATH-reachable location
- Usage: `pi-tool <toolname> '<json-args>'`
- Connects to socket (path from `PI_TOOL_SOCK` env var)
- Blocks until result, prints to stdout, exits with appropriate code

### 3. Socket lifecycle
- Extension creates socket on session start, removes on exit
- Path: `.pi/tool.sock` (inside worktree, always r/w)
- `PI_TOOL_SOCK` injected into every bash tool invocation

## Tools exposed
`git`, `subagent`, `read`, `write`, `edit`, `agent_browser`

## Open questions (for grilling)
- Streaming vs blocking for long-running tools?
- Error format — stderr + exit code, or JSON envelope?
- Should agent_browser be included (it's already a CLI)?
