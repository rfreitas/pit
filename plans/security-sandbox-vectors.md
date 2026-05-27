# Plan: sandbox escape vectors — known attack surface

## Scope

Everything outside the pit-escape socket (covered in
`plans/security-escape-hardening.md`). Vectors reachable from inside the bwrap
sandbox as currently configured.

## Current sandbox configuration

```
--tmpfs /
--dev   /dev
--proc  /proc
--ro-bind $HOME $HOME        ← full home, readable
--ro-bind /usr /etc /lib ... ← system dirs
--bind  <worktree> <agent-dir> ~/.npm mise/shims node_modules ...
--unshare-user
--unshare-pid
--die-with-parent
```

Not set: `--unshare-net`, `--clearenv`.

---

## V1 — Inherited environment variables ✅ addressed in escape-hardening plan

**What it is:** Full parent env is inherited. `GITHUB_TOKEN`, `AWS_*`,
`OPENAI_API_KEY`, etc. are readable via `process.env` or `printenv`.

**Fix:** `--clearenv` + explicit whitelist + `allowEnv` config. See
`plans/security-escape-hardening.md` Layer 2.

---

## V2 — Abstract Unix sockets (LOW — WSL dev machine)

**What it is:** Abstract namespace sockets (`\0`-prefixed) live in the kernel
and are scoped to the **network** namespace, not the IPC namespace. Without
`--unshare-net`, they are accessible from inside the sandbox.

If `DBUS_SESSION_BUS_ADDRESS` points to an abstract socket, the agent can reach
the session D-Bus, which exposes:
- `org.freedesktop.secrets` (GNOME Keyring) — stored passwords/tokens
- `org.freedesktop.systemd1` — start/stop user services
- Desktop automation (X11/Wayland screenshots, input injection)

**Why low risk on a WSL dev machine:** WSL typically has no desktop session
running. `DBUS_SESSION_BUS_ADDRESS` is either unset or points to a filesystem
socket in `/run/user/1000/` which is not mounted. Confirmed that the current
session has `DBUS_SESSION_BUS_ADDRESS` pointing to an abstract socket but no
GNOME Keyring or desktop daemon listening on it.

**Primary mitigation (already in plan):** `--clearenv` (V1 fix) removes
`DBUS_SESSION_BUS_ADDRESS` from the sandbox env, so even if the abstract socket
is reachable, the agent has no entry point without the address.

**Full mitigation:** `--unshare-net`. Deferred — would break AI API calls
without a proxy.

**Note:** `--unshare-ipc` does **not** address abstract sockets. IPC namespace
only isolates SysV IPC (shared memory, semaphores). Not worth adding.

---

## V3 — Readable credential files in $HOME (MEDIUM) ✅ partially addressed

**What it is:** `$HOME` is `--ro-bind` mounted. The agent can read:
- `~/.ssh/id_rsa` — private SSH keys
- `~/.aws/credentials` — AWS keys
- `~/.config/gh/hosts.yml` — GitHub CLI token
- `~/.netrc` — generic credentials

The agent cannot write them, but can read and exfiltrate over the network.

**Fix:** Replace `--ro-bind $HOME $HOME` with selective mounts covering only
what pi and git actually need. See `plans/security-escape-hardening.md` Layer 2
(selective home mounts).

**What is confirmed safe to exclude:** `~/.ssh`, `~/.aws`, `~/.config/gh`,
`~/.netrc`. Verified: pi reads auth from `AGENT_DIR/auth.json` (rw-mounted),
not from env vars or home dotfiles. SSH git operations go through the escape
server (outside bwrap) and are unaffected.

**Residual risk:** An agent using the bash tool to run git directly inside the
sandbox cannot access credential helpers that read from unmounted paths. This is
a pre-existing limitation of in-sandbox direct git use and is acceptable —
agent git operations route through the escape server.

---

## V4 — SSH agent socket (ZERO if V1 implemented)

**What it is:** `SSH_AUTH_SOCK` in the inherited env. If the socket is a
filesystem path in `/run/user/1000/` it is not mounted and not reachable. If it
is an abstract socket it falls under V2.

**Fix:** Covered by V1 (`--clearenv` removes `SSH_AUTH_SOCK`). No separate work.

---

## V5 — WSL Windows interop (WSL-specific, MEDIUM, hard to block)

**What it is:** On WSL2, `binfmt_misc` registers Windows PE executables at the
kernel level. bwrap's mount namespace does not block this. Calling `cmd.exe` or
`powershell.exe` from inside the sandbox executes on the Windows host with the
user's full Windows identity.

**Impact:** Full Windows host access — write arbitrary files, read Windows
credential stores, run PowerShell.

**Why hard to block:** `binfmt_misc` is a kernel-level hook on `execve()`.
bwrap creates a new mount namespace but does not intercept `execve`. A seccomp
filter could block `.exe` execution but is fragile with Node.js.

**Practical mitigation:** Document and provide the host-side opt-out:

```bash
# Disable for current boot:
echo 0 | sudo tee /proc/sys/fs/binfmt_misc/WSLInterop

# Permanently via /etc/wsl.conf:
[interop]
enabled=false
```

No bwrap-level fix. Not in scope for this implementation.

---

## V6 — Network (documented, deferred)

The network namespace is not isolated. The sandbox has the same outbound access
as the host. Fix requires `--unshare-net` + a forwarding proxy for pi's AI API
calls. Blocked on proxy work. Not addressed here.

---

## Priority and status

| Vector | Fix | Status |
|---|---|---|
| V1 env vars | `--clearenv` + whitelist + `allowEnv` | In plan (escape-hardening Layer 2) |
| V3 home credentials | Selective home mounts | In plan (escape-hardening Layer 2) |
| V4 SSH agent | Free from V1 | In plan |
| V2 abstract sockets | `--clearenv` removes entry point; full fix needs `--unshare-net` | Partially addressed by V1 |
| V5 WSL interop | Host-side opt-out only | Document in security.md |
| V6 network | Proxy + `--unshare-net` | Deferred |
