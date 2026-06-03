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
| Mode announcement | At session start, pit injects a description of the current pit mode (worktree branch and path, or no-tree reason) into the system prompt so the agent knows where it is. On resume, the announcement is refreshed with the current state. |

### Session resume

`pit -r` opens a full-screen session picker. It aggregates sessions from the current repo and all its linked worktrees into one list, sorted by most recent activity. Worktree sessions are labelled `[worktree branch:pi/<id>]` so they are distinguishable from sessions run in the repo root.

Picking a session reopens Pi in the correct worktree directory and refreshes the mode announcement with the current state.

---

## Sandbox

pit wraps Pi in an OS-level sandbox so the agent can only access what it needs. Active by default; pass `--no-sandbox` to disable.

| Platform | Backend | Model |
|---|---|---|
| Linux | [`bwrap`](https://github.com/containers/bubblewrap) (Bubblewrap) | Closed filesystem — reads and writes to unlisted paths are blocked |
| macOS | `sandbox-exec` (Seatbelt) | Write-closed filesystem — writes outside the allowlist are blocked; reads are globally open except for a default credential denylist |

If the sandbox backend is not available, pit warns and runs without a sandbox.

The sandbox features below use implementation-neutral names. Each has a platform-specific mechanism.

| Feature | What pit does |
|---|---|
| [Closed filesystem](#closed-filesystem) | The sandbox starts with no filesystem access. Every readable or writable path must be explicitly granted. |
| [Read grants](#read-grants) | A curated set of paths the agent may read: system directories, selective home dotfiles, and active Pi extensions. |
| [Write grants](#write-grants) | A curated set of paths the agent may read and write: the worktree, Pi config dir, npm cache, mise shims, Node.js binaries. |
| [Ephemeral layers](#ephemeral-layers) | Unversioned directories from the parent repo (e.g. `node_modules`) are overlaid onto the worktree. Writes to them are discarded when the session ends. |
| [Non-sandbox extensions](#non-sandbox-extensions) | Extension paths that only load when the sandbox is disabled. Security or audit extensions that need host filesystem access. |
| [Env seal](#env-seal) | The agent starts with a clean environment. Only an explicit allowlist of variables is passed in; shell credentials and tokens are not forwarded. |
| Process isolation | The agent runs in its own process namespace. Orphaned child processes are reaped when the session ends. |
| Lifetime binding | The sandbox process is tied to pit's lifetime. If pit exits or the terminal closes, the sandbox is killed. |
| Network policy | Outbound network access is unrestricted. The agent can reach AI APIs and package registries. |
| Sandbox announcement | At session start, pit appends a description of the active grants to the system prompt. The agent can read its own access boundaries. On resume, the announcement is refreshed with the current state. |

### Closed filesystem

On **Linux**: nothing is accessible unless explicitly granted via a read or write grant. Anything outside the grant lists — home directory contents, other projects, shell credentials, system state — is inaccessible.

On **macOS**: writes outside the grant list are blocked. Reads are globally open except for a default credential denylist (`~/.ssh`, `~/.aws`, `~/.gnupg`, and similar). The denylist is user-extensible via `sandbox.denyRead` in [config](#config).

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

### Non-sandbox extensions

Extensions listed in `nonSandboxExtensions` are passed as `--extension` flags only when the sandbox is **disabled** (`--no-sandbox`). They are ignored in sandbox mode.

Use this for extensions that assume full host filesystem access — security auditors, credential scanners, or tools that talk to host daemons. Inside the sandbox they would be blocked by the kernel and crash.

Configure in `~/.pi/pit/config.json`:

```json
{
  "nonSandboxExtensions": [
    "npm:@someone/my-auditor"
  ]
}
```

Entries use the same format as `packages` in `settings.json` — npm specifiers (`npm:`), git URLs (`github:`), or local filesystem paths.

### Env seal

The agent process starts with a clean environment. Variables forwarded by default: `HOME`, `PATH`, `TERM`, `LANG`, HTTP proxy variables (`http_proxy`, `https_proxy`, `no_proxy`, and uppercase variants). Variables present in your shell that are not on the allowlist — API tokens, credentials, tool-specific env — are not forwarded. Additional variables can be added via `allowEnv` in [config](#config).

---

## Config

`~/.pi/pit/config.json` — all fields optional.

| Field | Type | What it does |
|---|---|---|
| `nonSandboxExtensions` | `string[]` | Package sources to load only when sandbox is disabled. Same format as `packages` in `settings.json` — see [Non-sandbox extensions](#non-sandbox-extensions) |
| `allowEnv` | `string[]` | Extra env var names to forward into the sandbox — see [Env seal](#env-seal) |
| `sandbox.allowRead` | `string[]` | Linux: adds paths to the read allowlist. macOS: removes paths from the read denylist (grant read access to a path that would otherwise be denied). |
| `sandbox.denyRead` | `string[]` | macOS only: adds paths to the read denylist beyond the defaults. No effect on Linux. |
| `sandbox.allowWrite` | `string[]` | Both platforms: adds paths the agent may write to. |

---

## Flag passthrough

| Behaviour | What pit does |
|---|---|
| Pi flags | All Pi flags pass through unchanged. pit strips only `--no-sandbox` and `-nt`/`--no-tree` before forwarding. |
| Pi subcommands | `install`, `remove`, `update`, `list`, `config`, etc. are forwarded directly to `pi` with no worktree or sandbox setup. |
| Info-only flags | `-h`/`--help`, `-v`/`--version`, `--list-models`, `--export` skip worktree and sandbox setup entirely. |
| `--no-session` | Implies `--no-tree`. Without a session there is no way to track, resume, or clean up a worktree; creating one would leave an orphan branch. |
