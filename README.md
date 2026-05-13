# pit

> Sandboxed Pi with Git Worktrees — controlled agents running free.

`pit` is a transparent wrapper around the [Pi coding agent](https://pi.dev) that does two things every time you start a session:

1. **Isolates work** — creates a fresh git worktree on its own branch (`pi/<id>`), so the agent operates on a copy of your code, not your main branch.
2. **Sandboxes the process** — wraps Pi inside a [`bwrap`](https://github.com/containers/bubblewrap) (Bubblewrap) namespace so the agent can only see what it needs.

The result: you can hand a task to an agent and let it run freely, knowing it cannot touch your main branch and cannot reach outside its sandbox.

---

## Usage

```bash
pit                  # create worktree (branch: pi/<id>), launch Pi sandboxed
pit -nt              # skip worktree; run in current dir (sandbox still applies)
pit -r               # resume a previous pit session (worktree-aware picker)
pit list             # list pit worktrees for this repo
pit list --all       # list pit worktrees across all repos
pit clean            # remove orphaned registry entries
pit clean <id>       # remove a specific worktree, branch, and registry entry
```

All standard Pi flags pass through unchanged.

**Platform:** requires bash + git + Linux (bwrap). On Windows, use WSL.

```bash
# Add to PATH (~/.bashrc or ~/.bash_profile)
export PATH="$HOME/Repos/agent/pit:$PATH"
```

---

## Security model

pit's sandbox is **OS-level** and **allowlist-based**. When bwrap is available, Pi is launched inside a new Linux user/PID namespace with a minimal filesystem:

| Mount | Access | Why |
|---|---|---|
| Worktree directory | read-write | the agent's workspace |
| Pi config dir (`~/.pi/agent`) | read-write | auth tokens, settings |
| Node runtime + pi binary | read-only | needed to run |
| Extension dirs + `node_modules` | read-only | Pi extensions |
| `/usr`, `/etc`, `/lib`, `/proc`, `/dev` | read-only | system baseline |
| Everything else | **not mounted** | inaccessible |

The agent cannot read your home directory, other projects, SSH keys, or anything outside the worktree unless it was explicitly mounted.

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

pit's bwrap boundary applies to the entire Pi process — every tool, every extension, every line of code running in the session. Heimdall's bash sandbox and regex filters operate within that boundary, covering a subset of what pit already constrains at the OS level.

---

## Git worktree isolation

Each `pit` session creates:

- a new branch `pi/<id>` off `HEAD`
- a sibling directory `<repo>-wt-<id>` for the worktree

The agent works entirely in that directory. Your main working tree is untouched. When the work is done you review and merge (or discard) like any branch.

Sessions and worktrees are tracked in `~/.pi/pit/registry.json`. Use `pit clean` to remove them when you're done.

---

## Installation

```bash
git clone https://github.com/ricfr/pit ~/Repos/agent
cd ~/Repos/agent
npm install
export PATH="$HOME/Repos/agent/pit:$PATH"
```

Requires: Node.js ≥ 22, git, bwrap (install via your distro's package manager — `bubblewrap` on Debian/Ubuntu/Arch).

---

## Repository layout

```
pit/          pit itself (main package)
extensions/   Pi extensions loaded globally (auto-picked up by Pi)
packages/     Extension subprojects with tests (source of truth for extensions/)
plans/        Design docs and notes
```

### Included extensions

| Extension | Purpose |
|---|---|
| `/handoff` | Move the current session to a different project |
| `/rename` | Ask the model to name the session |
| `/chat-summary` | Summarise the conversation |
| `sudo` | Prompt before running privileged commands |
