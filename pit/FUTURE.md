# Future features

Planned enhancements for pit. Not yet scheduled — design notes only.

---

## Per-session file isolation in the sandbox

**Problem:** The entire Pi config directory (`agentDir`) is mounted read-write inside the sandbox. This means a sandboxed agent can write to — and corrupt or delete — session files belonging to other pit or pi sessions.

**Goal:** A pit process should only be able to write to its own session file, while retaining read access to all other session files in the same config directory.

**Current state:** `buildSandboxMountSpec` adds `agentDirReal` as a single read-write grant:

```ts
const rw = [
  // ...
  { path: agentDirReal, label: "Pi config dir" },
  // ...
];
```

Both bwrap and sandbox-exc treat this as a single unit — no finer granularity.

**Approach:**

1.  **Identify the session file path** before building mounts. The session id is known at launch time (new or resumed).

2.  **Restructure the mount spec** so that `agentDirReal` is no longer a single rw entry. Instead:
    *   Mount `agentDirReal` as **read-only**.
    *   Identify the specific session file path (e.g. `join(agentDirReal, "sessions", `${sessionId}.json`)`) and mount it as **read-write** on top of the ro base.

3.  **Platform specifics:**
    *   **Linux / bwrap:** Use `--ro-bind` for `agentDirReal`, then `--bind` for the individual session file. bwrap applies mounts in order; the later bind will override the earlier ro-bind for that exact path.
    *   **macOS / sandbox-exec:** SBPL matches on real paths. The read-write `(allow file-write* (subpath ...))` can be narrowed to the specific session file path while the parent directory remains read-only via the global `(allow file-read*)` and no write grant for the parent.

4.  **Handle known subdirs:** Pi writes to other locations inside `agentDir` at runtime — `sessions/`, `bin/`, `themes/`, `prompts/`, `git/`, plus `settings.json`. Most of these should remain read-only inside the sandbox. Any that legitimately need writes (e.g. `settings.json` updates via `/reload`) should be routed through `pit-escape`, not direct sandbox access.

5.  **Edge cases:**
    *   Session file may not exist yet for a brand-new session. The rw bind should target the path where it *will* be created.
    *   Pi may rename or rotate session files. The mount should follow the canonical path Pi uses.
    *   `SessionManager.listAll()` and session scanning inside the sandbox should still work — they only need read access to the `sessions/` directory.

**Open questions:**
- Should `settings.json` also become ro-only in the sandbox, with all writes via `pit-escape`? This would close a hole where an extension could mutate package lists or auth state directly.
- What about `auth.json` or other credentials in `agentDir`? They should probably be ro-only already, but the current blanket rw mount exposes them to writes.
- How does this interact with the dir-remap / symlink mirror on macOS? The mirror symlinks everything; narrowing rw to a single file means the mirror must set up the session file as a real file (or bind mount) rather than a symlink.

**Security benefit:** A compromised extension or agent prompt inside one sandbox session cannot destroy or tamper with the session history of other concurrent or past sessions.
