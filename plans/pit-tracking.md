# Plan: pit worktree tracking and namespacing

## Problem

`git worktree list` shows all worktrees for a repo — there is no built-in way to distinguish:

- worktrees created by `pit` (pi agent tasks)
- worktrees created by the developer manually for other purposes

There is also no cross-repo visibility. If you have 3 repos each with 2 active `pit` worktrees, there is no single place to see all 6.

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
Liveness is checked by testing if the worktree dir still exists on disk.

---

## Current state

`pit` already does light namespacing:

- **branch name:** `pi/<slug>-<timestamp>`
- **worktree dir:** `<repo>-wt-<slug>-<timestamp>`

This is enough to identify pit worktrees by convention but has no
persistent tracking and no cross-repo visibility.

---

## Registry

Location: `~/.pi/pit/registry.json`

Structure:

```json
{
  "worktrees": [
    {
      "task": "fix-login",
      "branch": "pi/fix-login-20260510-153000",
      "repo": "C:/Users/ricfr/Repos/myrepo",
      "worktree": "C:/Users/ricfr/Repos/myrepo-wt-fix-login-20260510-153000",
      "created": "2026-05-10T15:30:00Z"
    }
  ]
}
```

- `pit new` → appends entry
- `pit clean` → removes entry
- `pit list` → reads registry, filters to current repo by default

---

## pit list behaviour

Default (current repo only):

```
TASK          BRANCH                          WORKTREE                                  STATUS
fix-login     pi/fix-login-20260510-153000    myrepo-wt-fix-login-20260510-153000       active
write-tests   pi/write-tests-20260509-0900    myrepo-wt-write-tests-20260509-090000     orphaned
```

With `--all` (all repos):

```
REPO          TASK          BRANCH                          STATUS
myrepo        fix-login     pi/fix-login-20260510-153000    active
myrepo        write-tests   pi/write-tests-20260509-0900    orphaned
other-repo    refactor      pi/refactor-20260508-1200       active
```

Status:
- **active** — worktree dir exists on disk
- **orphaned** — registry entry exists but worktree dir is gone

---

## pit clean behaviour

```bash
pit clean <task>          # remove specific worktree by task name (fuzzy match)
pit clean --orphaned      # remove all registry entries whose dir no longer exists
```

`pit clean` → removes worktree dir, deletes branch, removes registry entry.

---

## Session file resolution

Pi stores sessions at:

```
~/.pi/agent/sessions/--<worktree-path-encoded>--/<timestamp>_<uuid>.jsonl
```

Since the path encoding is deterministic, `pit` can derive the session
bucket dir from the worktree path without storing it in the registry.

This keeps the registry minimal — no need to track session paths explicitly.

---

## Implementation order

1. Add `~/.pi/pit/registry.json` read/write to `pit new` and `pit clean`
2. Update `pit list` to read from registry, default to current repo
3. Add `pit list --all` for global view
4. Add `pit clean --orphaned`
