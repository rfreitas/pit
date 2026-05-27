# pi-tool CLI Spec

## Invocation

```
pi-tool <tool> [args]
pi-tool --list
pi-tool --describe <tool>
pi-tool --help
```

## Input

Input is read from stdin. The CLI parses it and branches on shape:

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
        anything else  →  error: tool requires JSON object input + schema
```

### JSON mode

Primary mode for structured tools. Use `jq` to construct JSON safely:

```bash
# static
echo '{"agent":"reviewer","task":"review src/"}' | pi-tool subagent

# dynamic args via jq — no quoting issues
jq -n --arg agent "reviewer" --arg task "review $path" \
  '{agent:$agent,task:$task}' | pi-tool subagent

# numbers/booleans
jq -n --arg path "src/foo.ts" --argjson offset "$line" \
  '{path:$path,offset:$offset}' | pi-tool read
```

### Positional mode

For tools whose only required parameter is a `string` or `string[]`.
Everything after the tool name is the value.

```bash
pi-tool git status
pi-tool git commit -m "fix: thing"
pi-tool run-script build --watch
```

Optional fields (e.g. `timeout?: number`) do not disqualify positional mode —
only required fields are counted.

### Error output

When positional is used on a structured tool, the error includes the full
schema and a generated `jq` example:

```
Error: tool 'subagent' requires structured input.

Schema:
  agent  string  (required)  Agent name to delegate to
  task   string  (required)  Task for the agent to perform

Usage:
  jq -n --arg agent "..." --arg task "..." '{agent:$agent,task:$task}' | pi-tool subagent
```

TypeBox field errors surface directly for malformed JSON objects:

```
Error: invalid input for tool 'subagent'
  missing required field: task (string)
```

## Output

### Stdout — plain text (default)

`content[]` joined as plain text. Suitable for `$()` capture:

```bash
result=$(pi-tool git status)
```

### Stdout — JSON envelope (`--output json`)

```json
{ "ok": true, "content": "...", "details": {} }
{ "ok": false, "error": "Tool 'foo' not found", "code": "TOOL_NOT_FOUND" }
```

### Stderr

Human-readable diagnostics only. Never mixed with result content.

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Tool execution error |
| 2 | CLI usage error (bad args, unknown tool) |
| 3 | Socket error (pi not running, timeout) |

## Streaming

```bash
pi-tool subagent --stream << 'EOF'
{"agent":"builder","task":"build and test"}
EOF
```

Emits JSON-lines to stdout:

```
{"type":"update","content":"Planning..."}
{"type":"result","ok":true,"content":"Done.","details":{}}
```

Without `--stream`, blocks silently until complete.

## Discovery

```bash
# list available tools
pi-tool --list

# inspect schema for a tool
pi-tool --describe subagent
```

`--list` reflects the live set — custom extension tools appear immediately
when registered. Only non-builtin tools are exposed, except `git` which is
builtin but sandboxed and requires the bridge.

## Environment

Injected automatically into every bash tool call by the extension:

```bash
PI_TOOL_SOCK=<worktree>/.pi/tool.sock
PATH=<worktree>/.pi/bin:$PATH
```

Scripts do not need to set these manually.

## Examples

```bash
# git in a sandboxed script
pi-tool git add .
pi-tool git commit -m "checkpoint"

# delegate to subagent, capture output
summary=$(echo '{"agent":"summariser","task":"summarise src/"}' | pi-tool subagent)
echo "$summary" > SUMMARY.md

# dynamic args
jq -n --arg task "review $changed_files" '{agent:"reviewer",task:$task}' \
  | pi-tool subagent

# stream progress
echo '{"agent":"builder","task":"build and test"}' | pi-tool subagent --stream

# error handling
if ! pi-tool git commit -m "auto"; then
  echo "commit failed" >&2
  exit 1
fi
```
