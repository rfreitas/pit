# pit

> Sandboxed Pi with Git Worktrees — controlled agents running free.

> [!WARNING]
> This project is still in development. Expect rough edges and breaking changes.

`pit` is a transparent wrapper around the [Pi coding agent](https://pi.dev) that does two things every time you start a session:

1. **Isolates work** — creates a fresh git worktree on its own branch (`pi/<id>`), so the agent operates on a copy of your code, not your main branch.
2. **Sandboxes the process** — wraps Pi inside a [`bwrap`](https://github.com/containers/bubblewrap) (Bubblewrap) namespace so the agent can only see what it needs.

The result: you can hand a task to an agent and let it run freely, knowing it cannot touch your main branch and cannot reach outside its sandbox.

---

## Usage

```bash
pit                          # create worktree (branch: pi/<id>), launch Pi sandboxed
pit -nt / --no-tree          # inside a git repo, skip worktree; run in current dir instead
pit --no-sandbox             # disable bwrap sandboxing (combinable with any other flag)
pit -r                       # resume a session (see below)
```

All standard Pi flags pass through unchanged.

**Platform:** requires bash + git + Linux. On Windows, use WSL.

---

## Security model

pit's sandbox is **OS-level** and **allowlist-based**. The Pi session runs inside a `bwrap` user/PID namespace with a minimal filesystem. The agent can read and write its worktree, git metadata, and your home directory (read-only). Everything else is inaccessible.

> **Limitation — IPC channels cross sandbox boundaries.** bwrap enforces filesystem and process isolation, but not IPC. A process running inside the session can reach any Unix socket on the host. See [`security.md`](./security.md).

The agent's worktree starts with ephemeral read access to unversioned directories from the parent repo (e.g. `node_modules`). Writes to those directories succeed but vanish when the session ends.

### How this differs from Heimdall

[`pi-heimdall`](https://github.com/casualjim/pi-heimdall) is a Pi extension that works at the tool level. Its protection is uneven by design:

- **bash tool** — actually sandboxed (restricted execution environment)
- **other built-in tools** — regex filtering only (denylist patterns on arguments)
- **extension tools** — no protection at all

pit operates at a different layer entirely:

| | Heimdall | pit |
|---|---|---|
| **Layer** | Pi extension (application) | OS namespaces (kernel) |
| **Approach** | denylist — block known-bad | allowlist — permit only what's listed |
| **Scope** | per-tool, uneven coverage | whole process, every tool, every syscall |
| **Extension tools** | unprotected | sandboxed like everything else |
| **Bypass risk** | unprotected tools, creative patterns | kernel-enforced, no bypass |
| **Works on** | any OS Pi runs on | Linux (WSL works) |

---

## Session resume (`pit -r`)

`pit -r` opens a session picker showing sessions from the current repo and all its worktrees together. Worktree sessions are labelled `[worktree branch:pi/<id>]` so you can tell them apart. Picking one resumes it in the correct worktree directory with its sandbox.

---

## Extension denylist

Suppress specific Pi packages in agent sessions. Create `~/.pi/pit/config.json`:

```json
{
  "denyPackages": [
    "npm:@casualjim/pi-heimdall",
    "npm:@spences10/pi-confirm-destructive",
    "npm:@jerryan/pi-sanity"
  ]
}
```

Package sources must match the entries in your Pi `settings.json` exactly. The real settings file is never modified.

---

## Installation

```bash
git clone https://github.com/ricfr/pit ~/Repos/agent
cd ~/Repos/agent
npm install
export PATH="$HOME/Repos/agent/pit:$PATH"
```

Requires: Node.js ≥ 22, git. bwrap is optional but recommended — install via your distro's package manager (`bubblewrap` on Debian/Ubuntu/Arch).

---

### Included extensions
|---|---|
| `/handoff` | Move the current session to a different project |
| `/rename` | Ask the model to name the session |
| `/chat-summary` | Summarise the conversation |
| `sudo` | Prompt before running privileged commands |
