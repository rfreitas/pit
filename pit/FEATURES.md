# pit features

Everything pit does, from the user's point of view.

---

## Worktree isolation

When you run `pit` inside a git repo, pit creates a fresh git worktree on a new branch (`pi/<id>`) next to your repo directory. Pi runs there, not in your working tree.

- Your main branch is untouched for the duration of the session.
- The agent can commit, rewrite, and delete files freely — all of it is contained to the worktree branch.
- When you are done, you review and merge (or discard) at your own pace.

If you are not inside a git repo, or you pass `-nt` / `--no-tree`, pit skips worktree creation and runs Pi in the current directory.

### Linked-worktree detection

If you `cd` into an existing worktree and run `pit`, pit recognises that you are already in a linked worktree and does not create another one. It finds and resumes the existing pit session for that worktree, or starts a fresh no-tree session if none exists.

### Worktree recovery

When you resume a session whose worktree directory has been deleted (e.g. you ran `git worktree remove` manually), pit recreates the worktree from the still-live branch before launching Pi. If the branch itself is gone, pit exits with an error rather than silently creating a new one.

---

## Session persistence

Every pit launch writes a session file before starting Pi. The file records:
- the pit mode (worktree or no-tree)
- the worktree path and branch name
- a creation timestamp and session id

This means you can close the terminal and come back later. `pit -r` (resume) reads these files to show you what is available.

### Resume picker (`pit -r`)

`pit -r` opens a full-screen session picker. It aggregates sessions from your current repo and all its linked worktrees in one list, sorted by most recent activity. Worktree sessions are labelled `[worktree branch:pi/<id>]` so you can tell them apart from sessions run directly in the repo root.

Picking a session reopens Pi pointing at the correct directory and re-injects the mode announcement (see [Sandbox announcement](#sandbox-announcement)) so the agent knows where it is.

---

## Sandbox

pit wraps the Pi process in an OS-level sandbox so the agent can only access what it needs. The sandbox is on by default and can be disabled with `--no-sandbox`.

On Linux, the sandbox backend is [`bwrap`](https://github.com/containers/bubblewrap) (Bubblewrap). If `bwrap` is not installed, pit warns and runs without a sandbox.

The following are the logical features the sandbox provides. Each has a platform-specific implementation; the feature names are implementation-neutral.

### Closed filesystem

The sandbox starts with no filesystem access at all. Every path the process can reach must be explicitly granted. Anything not listed is inaccessible — the agent cannot read your home directory, other projects, credentials, or system state beyond what is in the grant lists below.

### Read grants

Paths the agent may read but not write. Includes: system directories (`/usr`, `/etc`, and equivalents), selective home dotfiles (`.gitconfig`, `.npmrc`, mise installs — the minimum for git and npm to work), and any Pi extensions currently configured.

### Write grants

Paths the agent may read and write. Includes: the worktree directory, Pi's config directory (sessions, auth), the npm cache, mise shims, and the Node.js binary and global modules directory.

### Ephemeral layers

Unversioned directories from the parent repo (e.g. `node_modules`, `dist`) that exist next to the worktree are overlaid onto the worktree at matching paths. The agent can read them as if they were part of the worktree, and can write to them freely — but all writes are discarded when the session ends. The parent's files are never modified.

This means the agent can run tests, execute build scripts, and import packages without you needing to reinstall dependencies in every new worktree.

### Dir remap

The agent's config directory is presented at a controlled path with a filtered `settings.json` substituted in (see [Extension denylist](#extension-denylist)). The real `settings.json` on the host is never visible inside the sandbox. All other files (sessions, auth, etc.) in the config directory remain readable and writable through the remap.

### Env seal

The agent process starts with a clean environment. Only a defined allowlist of variables is passed in: `HOME`, `PATH`, `TERM`, `LANG`, proxy variables (`http_proxy`, `https_proxy`, etc.), and any extras you configure in `allowEnv` (see [Config](#config)). Credentials, tokens, and tool-specific variables present in your shell are not forwarded.

### Process isolation

The agent runs as PID 1 in its own process namespace. Orphaned child processes are reaped automatically when the session ends.

### Lifetime binding

The sandbox process is bound to the pit launcher's lifetime. If pit exits, the sandbox is killed. If the terminal is closed, the sandbox is killed.

### Network policy

Outbound network access is unrestricted. The agent needs to reach AI APIs and package registries. Network isolation is not currently enforced (see [`security.md`](../security.md)).

### Sandbox announcement

When the sandbox is active, pit appends a description of the active grants to the system prompt at the start of every session. The agent can read its own access boundaries. When you resume a session, the announcement is refreshed with the current grant state.

---

## Extension denylist

You can prevent specific Pi packages from loading inside pit sessions. Create `~/.pi/pit/config.json`:

```json
{
  "denyPackages": ["npm:@casualjim/pi-heimdall"]
}
```

Entries must match the package source strings in your Pi `settings.json` exactly. The real `settings.json` is never modified — a filtered copy is injected via the [Dir remap](#dir-remap) at session start.

---

## Config

`~/.pi/pit/config.json` controls pit behaviour. All fields are optional.

| Field | Type | Description |
|---|---|---|
| `denyPackages` | `string[]` | Package sources to strip from settings inside the sandbox |
| `allowEnv` | `string[]` | Extra env var names to forward into the sandbox on top of the built-in defaults |

---

## Flag passthrough

All Pi flags pass through to Pi unchanged. pit strips only its own flags (`--no-sandbox`, `-nt`/`--no-tree`) before forwarding.

`--no-session` implies `--no-tree`: without a session there is nothing to track, resume, or associate with a worktree.

Pi subcommands (`install`, `remove`, `update`, `list`, `config`, etc.) are forwarded directly to the `pi` binary without any worktree or sandbox setup.

Info-only flags (`-h`/`--help`, `-v`/`--version`, `--list-models`, `--export`) skip worktree and sandbox setup entirely.
