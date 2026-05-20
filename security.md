# Security model

## The core guarantee

pit's bwrap sandbox gives OS-level, allowlist-based filesystem isolation. The
agent process can only see what is explicitly mounted. Every tool, every
extension, every line of code running in the session is constrained by the same
kernel-enforced boundary.

This is a strong guarantee — but it is a **filesystem and process** guarantee.
It says nothing about what the sandboxed process can do via network or IPC
channels it can reach.

---

## The fundamental limitation: IPC channels cross sandbox boundaries

Bubblewrap (and Linux namespaces in general) isolate:

- **Filesystem access** — only mounted paths are visible
- **Process visibility** — only processes in the same PID namespace
- **User identity** — the sandboxed process runs as an unprivileged mapped UID

They do **not** isolate:

- **Unix sockets already open or reachable** — if a socket path is mounted into
  the sandbox, or its path is known and reachable via a mounted directory, the
  sandboxed process can connect to it
- **TCP/UDP** — unless the network namespace is also isolated (pit does not
  currently isolate the network namespace)

The general principle: **any privileged service that a sandboxed process can
speak to is effectively an extension of the sandbox's capabilities**. The kernel
enforces the filesystem boundary; it has no knowledge of what the application
does over a socket once the connection is open.

This is the same class of problem as:

- A Docker container reaching `/var/run/docker.sock` — gives it full Docker API
  access regardless of what the container filesystem can see
- A container with access to the host SSH agent socket — can authenticate as the
  host user
- A Flatpak that can reach a privileged D-Bus service

---

## pit-escape: the intentional privileged channel

pit needs to perform certain operations outside the sandbox on the agent's
behalf. Rather than granting the sandboxed session direct write access to
shared git state or the host settings file, pit delegates these operations to
a small helper process (`escape/server.ts`) that runs outside bwrap.

Communication is over a Unix socket. The socket path is passed into the sandbox
via `PIT_ESCAPE_SOCKET`. The protocol is unauthenticated newline-delimited JSON.

### What the socket exposes

| Op | Effect on host |
|---|---|
| `git add\|commit\|diff\|log\|merge\|rebase\|reset\|show\|stash\|status` | runs git in the worktree — commit writes refs/heads/ |
| `get-state` | reads branch, merge in progress, conflicts, parent branch |
| `merge-to-parent` | fast-forward merges the worktree branch into master/main |
| `rename-branch` | runs `git branch -m` — writes refs/heads/ |
| `refresh-settings` | overwrites the shadow settings file on the host |
| `is-merged` | reads merge ancestry |
| `subscribe` | watches parent branch ref via fs.watch, pushes events |

### Why this is a trust boundary, not a hardened channel

The socket accepts connections from **any process in the sandbox** that knows
`PIT_ESCAPE_SOCKET`. There is no shared secret, no authentication token, no
verification that the request came from the legitimate pi session rather than
an extension or a subprocess it spawned.

In practice this means a loaded extension — including a malicious npm package
that somehow ended up in `settings.json` — can:

- Commit arbitrary content to the worktree branch
- Merge the worktree branch into master/main without user confirmation
- Rename the branch
- Overwrite the filtered settings file

It cannot run arbitrary shell commands (the git op is limited to the allowlist),
and it cannot escape bwrap's filesystem restrictions for anything not mediated
by the socket.

---

## Relationship to the extension denylist

`pit/config.json`'s `denyPackages` prevents specific packages from loading
inside sandboxed sessions. This is the primary control against malicious
extensions. A package that is not loaded cannot connect to the socket.

However, a package that *is* loaded — even a legitimate one with a supply-chain
compromise — has full access to `PIT_ESCAPE_SOCKET`.

---

## Network access

pit does not currently isolate the network namespace. The sandboxed agent has
the same outbound network access as the host user. This is intentional: the
agent needs to reach AI provider APIs.

Inbound: the sandbox runs in an unprivileged user namespace with `--unshare-pid`,
so it cannot bind privileged ports, but it can open arbitrary outbound
connections.

---

## What bwrap *does* protect against

Despite the above, the filesystem isolation is real and meaningful:

- The agent cannot read or write files outside its mounted paths — home
  directory is read-only, the parent repo is not mounted at all (only the
  worktree is), other repos and system files are inaccessible
- The agent cannot exfiltrate your SSH private key by writing it somewhere
  (it can read `~/.ssh` but cannot write outside the worktree without going
  through the escape socket, which has no file-write op)
- The agent cannot persist anything to the parent repo directly — only the
  worktree is rw-mounted; changes to the parent go through git merge after
  human review
- The overlay mounts for unversioned dirs are ephemeral — writes to
  `node_modules` etc. vanish on session end

---

## Possible mitigations (not yet implemented)

**Authentication token:** generate a random nonce at session start, pass it to
pit-escape and into the sandbox as a separate env var. Require every request to
include it. This does not prevent a malicious extension from reading the env var,
but it raises the bar slightly and makes the trust model explicit in the protocol.

**Op confirmation for destructive ops:** `merge-to-parent` and `rename-branch`
affect shared git state. These could require explicit TUI confirmation from the
human rather than being callable unilaterally.

**Network namespace isolation:** add `--unshare-net` to the bwrap args and set
up a restricted network config. This would break AI provider access unless a
proxy is provided.

**Scope `PIT_ESCAPE_SOCKET` to the pi process only:** currently all environment
variables are inherited by subprocesses. Clearing `PIT_ESCAPE_SOCKET` from
subprocess environments (e.g. via a wrapper) would limit exposure, but pi
itself needs it for the git tool.
