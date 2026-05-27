# pit features

## Worktree isolation

| Feature | What pit does |
|---|---|
| [Worktree creation](#worktree-creation) | Creates a git worktree on a new `pi/<id>` branch next to the repo. Pi runs in the worktree; the main branch is untouched until the user reviews and merges. |
| [No-tree mode](#no-tree-mode) | When worktree creation is not applicable, pit runs Pi in the current directory with no git isolation. |
| Linked-worktree detection | If you are already inside a linked worktree, pit does not create another one. It finds and resumes the existing pit session for that worktree, or starts a no-tree session if none exists. |
| Worktree recovery | On resume, if the worktree directory has been deleted, pit recreates it from the branch before launching Pi. If the branch is also gone, pit exits with an error. |

### Worktree creation

A new branch (`pi/<id>`) and a matching worktree directory (`<repo>-wt-<id>`) are created at session start. The agent commits, rewrites, and deletes files freely there. The main working tree is untouched. When done, the user reviews the branch and merges or discards it.

### No-tree mode

When pit cannot or should not create a worktree, it runs Pi in the current directory. There is no git isolation; changes are immediate and direct.

| Cause | When it applies |
|---|---|
| No git repo | The current directory is not inside a git repository |
| Forced | `-nt` / `--no-tree` was passed explicitly |
| Already in worktree | The current directory is already a linked worktree (covered by linked-worktree detection) |

---

## Session persistence

| Feature | What pit does |
|---|---|
| Session creation | Writes a session file before starting Pi, pre-seeded with pit metadata: mode, worktree path, branch, session id, and a mode announcement. |
| [Session resume](#session-resume) | `pit -r` opens a full-screen picker aggregating sessions from the current repo and all its linked worktrees. |

### Session resume

`pit -r` opens a full-screen session picker. It aggregates sessions from the current repo and all its linked worktrees into one list, sorted by most recent activity. Worktree sessions are labelled `[worktree branch:pi/<id>]` so they are distinguishable from sessions run in the repo root.

Picking a session reopens Pi in the correct worktree directory and refreshes the mode announcement with the current state.

---

## Sandbox

pit wraps Pi in an OS-level sandbox so the agent can only access what it needs. Active by default; pass `--no-sandbox` to disable. On Linux the backend is [`bwrap`](https://github.com/containers/bubblewrap) (Bubblewrap) — if not installed, pit warns and runs without a sandbox.

The sandbox features below use implementation-neutral names. Each has a platform-specific mechanism.

| Feature | What pit does |
|---|---|
| [Closed filesystem](#closed-filesystem) | The sandbox starts with no filesystem access. Every readable or writable path must be explicitly granted. |
| [Read grants](#read-grants) | A curated set of paths the agent may read: system directories, selective home dotfiles, and active Pi extensions. |
| [Write grants](#write-grants) | A curated set of paths the agent may read and write: the worktree, Pi config dir, npm cache, mise shims, Node.js binaries. |
| [Ephemeral layers](#ephemeral-layers) | Unversioned directories from the parent repo (e.g. `node_modules`) are overlaid onto the worktree. Writes to them are discarded when the session ends. |
| [Dir remap](#dir-remap) | Pi's config directory is presented at a controlled path with a filtered `settings.json` substituted in. The real `settings.json` is never visible inside the sandbox. |
| [Env seal](#env-seal) | The agent starts with a clean environment. Only an explicit allowlist of variables is passed in; shell credentials and tokens are not forwarded. |
| Process isolation | The agent runs in its own process namespace. Orphaned child processes are reaped when the session ends. |
| Lifetime binding | The sandbox process is tied to pit's lifetime. If pit exits or the terminal closes, the sandbox is killed. |
| Network policy | Outbound network access is unrestricted. The agent can reach AI APIs and package registries. |
| Sandbox announcement | At session start, pit appends a description of the active grants to the system prompt. The agent can read its own access boundaries. On resume, the announcement is refreshed with the current state. |

### Closed filesystem

Nothing is accessible unless explicitly granted via a read or write grant. Anything outside the grant lists — home directory contents, other projects, shell credentials, system state — is inaccessible.

### Read grants

Paths the agent may read but not write:

- System directories (`/usr`, `/etc`, and platform equivalents)
- Selective home dotfiles: `.gitconfig`, `.config/git`, `.npmrc`, mise installs
- Any Pi extensions currently active in `settings.json`

### Write grants

Paths the agent may read and write:

- The worktree directory
- Worktree git metadata (`.git/worktrees/…`, `.git/objects`)
- Pi config directory (sessions, auth)
- npm cache (`~/.npm`)
- mise shims (`~/.local/share/mise/shims`)
- Node.js global modules and bin

### Ephemeral layers

Unversioned directories present in the parent repo (not tracked by git — e.g. `node_modules`, `dist`, `.cache`) are overlaid onto the corresponding paths in the worktree. The agent can read them and write to them freely. Writes go to a temporary layer that is discarded when the session ends; the parent's files are never modified.

This lets the agent run tests, execute build scripts, and import packages without reinstalling dependencies in every new worktree.

### Dir remap

Pi's config directory is presented to the agent at a controlled path. Inside that path, `settings.json` is replaced with a filtered copy (see [Extension denylist](#extension-denylist)). The real `settings.json` on the host is never exposed. All other config files (sessions, auth, etc.) are accessible through the remap and changes to them persist normally.

### Env seal

The agent process starts with a clean environment. Variables forwarded by default: `HOME`, `PATH`, `TERM`, `LANG`, HTTP proxy variables (`http_proxy`, `https_proxy`, `no_proxy`, and uppercase variants). Variables present in your shell that are not on the allowlist — API tokens, credentials, tool-specific env — are not forwarded. Additional variables can be added via `allowEnv` in [config](#config).

---

## Extension denylist

| Feature | What pit does |
|---|---|
| Package filtering | Strips specified Pi packages from `settings.json` before the session starts. The real `settings.json` is never modified; a filtered copy is injected via [dir remap](#dir-remap). |

Configure in `~/.pi/pit/config.json`:

```json
{
  "denyPackages": ["npm:@casualjim/pi-heimdall"]
}
```

Entries must match the package source strings in your Pi `settings.json` exactly.

---

## Config

`~/.pi/pit/config.json` — all fields optional.

| Field | Type | What it does |
|---|---|---|
| `denyPackages` | `string[]` | Package sources to strip from settings inside the sandbox |
| `allowEnv` | `string[]` | Extra env var names to forward into the sandbox beyond the built-in defaults |

---

## Flag passthrough

| Behaviour | What pit does |
|---|---|
| Pi flags | All Pi flags pass through unchanged. pit strips only `--no-sandbox` and `-nt`/`--no-tree` before forwarding. |
| Pi subcommands | `install`, `remove`, `update`, `list`, `config`, etc. are forwarded directly to `pi` with no worktree or sandbox setup. |
| Info-only flags | `-h`/`--help`, `-v`/`--version`, `--list-models`, `--export` skip worktree and sandbox setup entirely. |
| `--no-session` | Implies `--no-tree`. Without a session there is no way to track, resume, or clean up a worktree; creating one would leave an orphan branch. |
