# pit

> Sandboxed Pi with Git Worktrees — controlled agents running free.

> [!WARNING]
> This project is not ready for production. Expect rough edges, breaking changes, and plenty of vibe code. It's a personal tool used by me, for me — use at your own risk.

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

**Platform:** requires bash + git. Linux (including WSL) and macOS are supported.

---

## Security model

pit's sandbox is **OS-level** and **allowlist-based**. The backend depends on the platform:

- **Linux**: [`bwrap`](https://github.com/containers/bubblewrap) (Bubblewrap) user/PID namespace. Closed filesystem — the agent can only read paths in an explicit allowlist.
- **macOS**: `sandbox-exec` (Seatbelt). Write-closed filesystem — writes outside the allowlist are blocked; reads are globally open except for a default credential denylist (`~/.ssh`, `~/.aws`, `~/.gnupg`, etc.).

On both platforms the agent can read and write its worktree, git metadata, and the Pi config directory. Everything else is restricted.

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

## Config

Create `~/.pi/pit/config.json` to customise pit's behaviour. All fields are optional.

```json
{
  "nonSandboxExtensions": [],
  "allowEnv": [],
  "sandbox": {
    "allowRead": [],
    "denyRead": [],
    "allowWrite": []
  }
}
```

| Field | Platform | What it does |
|---|---|---|
| `nonSandboxExtensions` | both | Extension paths passed to pi only in non-sandbox mode (e.g. security monitoring extensions that need host access). |
| `allowEnv` | both | Extra env var names to forward into the sandbox beyond the built-in defaults. |
| `sandbox.allowRead` | Linux: adds to read allowlist · macOS: removes from read denylist | Grant read access to specific paths. |
| `sandbox.denyRead` | macOS only | Block read access to additional credential paths beyond the defaults. No effect on Linux. |
| `sandbox.allowWrite` | both | Allow the agent to write to additional paths. |

---

## Installation

```bash
git clone https://github.com/ricfr/pit ~/Repos/agent
cd ~/Repos/agent
npm install
export PATH="$HOME/Repos/agent/pit:$PATH"
```

Requires: Node.js ≥ 22, git.
- **Linux**: bwrap is optional but recommended — `bubblewrap` on Debian/Ubuntu/Arch.
- **macOS**: `sandbox-exec` ships with macOS. No extra install needed.

---

### Included extensions
|---|---|
| `/handoff` | Move the current session to a different project |
| `/rename` | Ask the model to name the session |
| `/chat-summary` | Summarise the conversation |
| `sudo` | Prompt before running privileged commands |
