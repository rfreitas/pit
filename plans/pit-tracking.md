# Plan: pit worktree tracking and namespacing

## Problem

`git worktree list` shows all worktrees for a repo — there is no built-in way to distinguish:

- worktrees created by `pit` (pi agent tasks)
- worktrees created by the developer manually

There is also no cross-repo visibility, and no way to show the same
session name that Pi shows in its session picker.

---

## Design principle

Follow Pi's own architecture:

| Pi | pit |
|----|-----|
| `~/.pi/agent/sessions/` | `~/.pi/pit/registry.json` |
| sessions bucketed by cwd | registry entries tagged by repo |
| session picker shows current project by default | `pit list` shows current repo by default |
| Tab in picker shows all sessions | `pit list --all` shows all repos |

One central store. Local view by default. Global on demand.
No per-worktree marker files — the registry is the single source of truth.

---

## UUID as the shared identity

`pit` generates one UUID per worktree at creation time.
That UUID is used in three places:

```
branch:   pi/<slug>-<uuid>
worktree: <repo>-wt-<slug>-<uuid>
session:  ~/.pi/agent/sessions/--<worktree-path-encoded>--/<timestamp>_<uuid>.jsonl
```

This means the worktree dir, branch, and Pi session file are all
linked by the same UUID without any secondary lookup.

The registry stores only the UUID — everything else is derivable from it.

---

## How pit new works

1. Generate a UUID
2. Create the git branch and worktree dir (`<repo>-wt-<slug>-<uuid>`)
3. Pre-create the Pi session file at the correct bucket path with the UUID:
   - write the JSONL header line: `{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"<worktree-path>"}`
4. Append entry to `~/.pi/pit/registry.json`
5. Launch `pi --session <session-file-path>` inside the worktree

Pi loads the pre-created session and continues normally.
The user experience is identical to plain `pi`.

---

## Registry

Location: `~/.pi/pit/registry.json`

```json
{
  "worktrees": [
    {
      "uuid": "019e129c-224f-7512-8e88-1c7e392cc26b",
      "task": "fix-login",
      "repo": "C:/Users/ricfr/Repos/myrepo",
      "created": "2026-05-10T15:30:00Z"
    }
  ]
}
```

Everything else is derivable from `uuid`, `task`, and `repo`:

- branch: `pi/<slug(task)>-<uuid>`
- worktree: `<repo-parent>/<repo-name>-wt-<slug(task)>-<uuid>`
- session bucket: `~/.pi/agent/sessions/--<encoded-worktree-path>--/`
- session file: `<timestamp>_<uuid>.jsonl` inside that bucket

---

## pit list — display name

`pit list` reads each session file and extracts the display name
exactly as Pi does:

1. scan the JSONL for the latest `session_info` entry → use its `name` field
2. if none found, scan for the first `message` entry with `role: "user"` → use its text as preview

This means `pit list` shows the same name that Pi's session picker shows.

Default output (current repo):

```
TASK        BRANCH                                    SESSION NAME               STATUS
fix-login   pi/fix-login-019e129c                     refactor the auth flow     active
write-tests pi/write-tests-deadbeef                   (no session yet)           active
old-task    pi/old-task-cafebabe                      add unit tests             orphaned
```

With `--all`:

```
REPO        TASK        BRANCH                        SESSION NAME               STATUS
myrepo      fix-login   pi/fix-login-019e129c          refactor the auth flow     active
other-repo  refactor    pi/refactor-cafebabe           (no session yet)           active
```

Status:
- **active** — worktree dir exists on disk
- **orphaned** — registry entry exists but worktree dir is gone

---

## pit clean

```bash
pit clean <task>       # remove worktree + branch + registry entry (fuzzy match on task)
pit clean --orphaned   # remove all registry entries whose worktree dir no longer exists
```

---

## Implementation order

1. UUID generation on `pit new`
2. Pre-create Pi session file with UUID
3. Launch `pi --session <path>`
4. Registry read/write in `pit new` and `pit clean`
5. `pit list` with session name resolution
6. `pit list --all`
7. `pit clean --orphaned`
