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

```bash
# Add to PATH (~/.bashrc or ~/.bash_profile)
export PATH="$HOME/Repos/agent/pit:$PATH"
```

---

## Security model

pit's sandbox is **OS-level** and **allowlist-based**. Worktree creation and session setup run in the outer process; once that's done, the Pi session itself is launched inside a [`bwrap`](https://github.com/containers/bubblewrap) user/PID namespace with a minimal filesystem. If bwrap is not found, pit warns and runs unsandboxed.

> **Limitation — IPC channels cross sandbox boundaries.** bwrap enforces filesystem and process isolation, but not IPC. pit-escape runs outside the sandbox with full host access and listens on an unauthenticated Unix socket (`PIT_ESCAPE_SOCKET`). Any code running in the session, including extensions, can connect and issue its full op set. See [`security.md`](./security.md).

| Mount | Access | Why |
|---|---|---|
| Worktree directory | read-write | the agent's workspace |
| Worktree git metadata, objects | read-write | staging area and new git objects (commits via pit-escape) |
| `/pit-agent` (shadow agent dir) | read-write | auth tokens, filtered settings — session-scoped, dies with bwrap |
| Pi config dir (`~/.pi/agent`) | read-write | needed so `proper-lockfile` can create lock files next to `auth.json` |
| npm cache, mise shims | read-write | `pi install` inside a session |
| Node.js global modules + bin | read-write | `pi install` inside a session |
| Home directory (`~`) | read-only | Node runtime, mise installs, other shared tooling |
| Pi extensions + `node_modules` | read-only | Pi extensions |
| `/usr`, `/etc`, system dirs | read-only | system baseline |
| `/proc`, `/dev` | special | process/device fs |
| Unversioned dirs from parent repo | **ephemeral overlay** | agent reads parent's `node_modules` etc; writes vanish on exit |
| Everything else | **not mounted** | inaccessible |

The agent can read (but not write) your home directory, which includes `~/.ssh` and other sensitive files. If this matters for your workload, consider using Heimdall's bash sandbox on top of pit for finer-grained file-access control within the home directory.

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

## Session resume (`pit -r`)

`pit -r` opens a session picker. The current tab shows sessions from the
current repo **and all its worktrees** together, so you can resume any pit
session regardless of which directory you invoke it from. Worktree sessions
are labelled `[worktree branch:pi/<id>]` at the start of their display name
so you can tell them apart at a glance.

Picking a worktree session resumes it with the correct working directory and
sandbox bound to that worktree — not to wherever `pit -r` was invoked.

---

## Extension denylist

When running sandboxed, pit can suppress specific Pi packages that you don't want active in agent sessions. Create `~/.pi/pit/config.json`:

```json
{
  "denyPackages": [
    "npm:@casualjim/pi-heimdall",
    "npm:@spences10/pi-confirm-destructive",
    "npm:@jerryan/pi-sanity"
  ]
}
```

Package sources must match the entries in your Pi `settings.json` exactly. Any package not listed is loaded normally.

**How it works:** at session start, pit generates a filtered copy of your Pi settings and mounts it into the sandbox at `/pit-agent/settings.json` (via `PI_CODING_AGENT_DIR`). The real `~/.pi/agent/settings.json` is never modified. `/reload` inside a session re-applies the denylist against the current host settings, so globally-installed packages are picked up correctly.

**`--no-sandbox`** falls back to your full Pi settings unchanged — no filtering, no shadow dir.

### Ephemeral overlay mounts

For sandboxed sessions inside a linked worktree, pit automatically overlays all unversioned directories from the parent repo into the worktree using `bwrap --overlay-src / --tmp-overlay`:

- **Reads** come from the parent's content — `node_modules`, `dist`, build caches, etc.
- **Writes** succeed without error, landing in a per-session tmpfs upper layer
- **No persistence** — the overlay disappears when the session ends; the parent repo and real worktree are untouched

This means agent worktrees start with full access to installed packages and build artefacts without copying them on disk, and without risking pollution between sessions.

Detection uses `git ls-files --directory`, which recurses into tracked directories to find nested unversioned ones (e.g. `packages/foo/node_modules`) while reporting each as a unit — so a single mount covers the whole subtree.

---

## Git worktree isolation

Each `pit` session creates:

- a new branch `pi/<id>` off `HEAD`
- a sibling directory `<repo>-wt-<id>` for the worktree

The agent works entirely in that directory. Your main working tree is untouched. When the work is done you review and merge (or discard) like any branch.

Session metadata (id, branch, worktree path) is embedded directly in Pi's session file, so pit sessions appear normally in Pi's session picker and resume correctly.

**Running `pit` inside an existing worktree** does the right thing automatically: instead of nesting a second worktree, pit detects it is already in a linked worktree and resumes the existing pit session for that directory. If no session exists yet (e.g. you created the worktree manually), it starts a new no-tree session in place.

---

## pit-escape

Each sandboxed session spawns a small helper process (`pit-escape`) outside the bwrap namespace. It communicates with the sandboxed Pi over a Unix socket and handles operations that require host access:

- **git operations** — the `git` tool inside the session routes through pit-escape, scoped to permitted subcommands
- **settings refresh** — called by the bundled reload extension on `/reload` to regenerate the filtered settings file before Pi re-reads packages

The socket path is passed into the sandbox via `PIT_ESCAPE_SOCKET`. pit-escape exits when the session ends.

---

## Installation

```bash
git clone https://github.com/ricfr/pit ~/Repos/agent
cd ~/Repos/agent
npm install
export PATH="$HOME/Repos/agent/pit:$PATH"
```

Requires: Node.js ≥ 22, git. bwrap is optional but recommended for sandboxing — install via your distro's package manager (`bubblewrap` on Debian/Ubuntu/Arch). Without it, pit runs unsandboxed.

---

## Repository layout

```
pit/                 pit itself (main package)
  pit.ts             CLI boundary — entry point
  errors.ts          Effect tagged error types
  types.ts           shared TypeScript types
  core/              domain logic — no display (see core/README.md)
    constants.ts
    launcher.ts
    program.ts
    git/
    sandbox/
    session/
    worktree/
  escape/            out-of-sandbox helper (see escape/README.md)
    server.ts        socket boundary
    core/ops/        op implementations
  extensions/        loaded by Pi via jiti (see extensions/README.md)
    commands/        slash commands (/merge, /rename-branch)
    tools/           agent tools (git)
    status/          footer status items
    hooks/           session lifecycle hooks
    escape/          escape server transport client
eslint-rules/        custom ESLint rules (see eslint-rules/README.md)
extensions/          Pi extensions loaded globally
packages/            extension subprojects with tests
plans/               design docs
```

### Development

```bash
npm run typecheck   # TypeScript
npm run lint        # ESLint — zero errors required
npm test            # Vitest
```

See `pit/AGENTS.md` for the architecture overview, Effect usage, and import rules.

### Included extensions
|---|---|
| `/handoff` | Move the current session to a different project |
| `/rename` | Ask the model to name the session |
| `/chat-summary` | Summarise the conversation |
| `sudo` | Prompt before running privileged commands |

### pit-bundled extensions

These load only inside pit sessions:

| File | Kind | Purpose |
|---|---|---|
| `extensions/tools/git.ts` | agent tool | `git` — permitted subcommands routed through pit-escape |
| `extensions/commands/merge/` | user command | `/merge` — merge worktree branch back to parent |
| `extensions/commands/rename-branch/` | user command | `/rename-branch` — rename branch from session topic |
| `extensions/status/loc-diff.ts` | status item | lines changed vs parent branch |
| `extensions/status/merge-status.ts` | status item | merged/ahead/behind indicator |
| `extensions/hooks/reload.ts` | hook | refreshes filtered settings before Pi reloads packages |
