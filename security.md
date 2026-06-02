# Security

## bwrap scope

bwrap enforces filesystem and process isolation. It does not isolate IPC.

Any Unix socket or TCP endpoint reachable from inside the sandbox is outside
bwrap's control. If that endpoint has more privileges than the sandbox, the
sandboxed process can use those privileges by speaking to it.

## pit-escape socket

`escape/server.ts` runs outside bwrap with full host filesystem access. It
listens on a Unix socket; the path is in `PIT_ESCAPE_SOCKET` in the sandbox
environment. Any process in the session — including loaded extensions — can
connect and issue ops.

The protocol is unauthenticated newline-delimited JSON. There is no token.

### Ops and their host-side effects

| Op | Host effect |
|---|---|
| `git commit` | writes refs/heads/ |
| `merge-to-parent` | merges worktree branch into master/main |
| `rename-branch` | writes refs/heads/ |
| `refresh-settings` | overwrites shadow settings file |
| `git add\|diff\|log\|merge\|rebase\|reset\|show\|stash\|status` | read or local-state ops |
| `get-state`, `is-merged`, `subscribe` | read-only |

`merge-to-parent` and `rename-branch` modify shared git state without user
confirmation. Any code that can read the environment can trigger them.

## Sandbox

Packages listed in `settings.json` load unrestricted inside the sandbox.
The escape socket uses token authentication — a loaded package cannot
abuse pit-escape without the session token.

For extensions that should only run outside the sandbox, use
`nonSandboxExtensions` in `pit/config.json`.

## Network

The network namespace is not isolated. The session has the same outbound
network access as the host user.

## What bwrap does cover

- Files outside mounted paths are inaccessible (home dir is read-only, parent
  repo not mounted at all)
- The agent cannot write outside the worktree without going through the socket,
  which has no general file-write op
- Overlay writes to unversioned dirs (node_modules etc.) are ephemeral

## Mitigations not yet implemented

- **Auth token** — shared secret between pit.ts, pit-escape, and the sandbox
  env; required on every request
- **Confirmation for destructive ops** — `merge-to-parent` and `rename-branch`
  prompt the human before executing
- **Network namespace isolation** — `--unshare-net` with a proxy for AI APIs
