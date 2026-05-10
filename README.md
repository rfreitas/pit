# agent

Workspace for Pi agent tooling — extensions, scripts, and utilities for working with [pi](https://github.com/earendil-works/pi-coding-agent).

## Structure

```
extensions/   Pi extensions (auto-loaded globally via settings.json)
```

## Extensions

### handoff
Moves the current Pi session to another project directory.

```text
/handoff <target-directory>
```

- Rewrites the session `cwd` header
- Moves the session file into the target project's session bucket
- Prefixes the session name with `handedoff:` for easy identification
- Supports directory autocomplete on the path argument

## Setup

Extensions in `extensions/` are loaded globally via `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "C:/Users/ricfr/Repos/agent/extensions"
  ]
}
```
