# Plan: pit worktree tracking and namespacing

## Problem

`git worktree list` shows all worktrees for a repo — there is no built-in way to distinguish:

- worktrees created by `pit` (pi agent tasks)
- worktrees created by the developer manually for other purposes

There is also no cross-repo visibility. If you have 3 repos each with 2 active `pit` worktrees, there is no single place to see all 6.

---

## Current state

`pit` already does light namespacing:

- **branch name:** `pi/<slug>-<timestamp>`
- **worktree dir:** `<repo>-wt-<slug>-<timestamp>`

This is enough to identify pit worktrees by convention, but it is fragile:
- relies on parsing names
- no metadata stored
- `pit list` requires being inside the repo
- no link back to the Pi session file

---

## Goals

1. Reliably identify which worktrees belong to `pit`
2. Store metadata per worktree (task, branch, repo, Pi session)
3. Support `pit list` globally, across all repos
4. Support `pit clean` globally
5. Know if a worktree is active (Pi running) or abandoned

---

## Proposed approach

### Layer 1 — branch prefix (keep as-is)

Branch name `pi/<slug>-<timestamp>` stays as the primary namespace.

Queryable with:

```bash
git branch --list 'pi/*'
```

This is lightweight and works without any extra tooling.

### Layer 2 — marker file in each worktree

When `pit` creates a worktree, write a `.pit` file at the root:

```json
{
  "task": "fix-login",
  "branch": "pi/fix-login-20260510-153000",
  "repo": "C:/Users/ricfr/Repos/myrepo",
  "worktree": "C:/Users/ricfr/Repos/myrepo-wt-fix-login-20260510-153000",
  "created": "2026-05-10T15:30:00Z",
  "sessionFile": "C:/Users/ricfr/.pi/agent/sessions/--C--Users-ricfr-Repos-myrepo-wt-fix-login-20260510-153000--/<id>.jsonl"
}
```

This makes any worktree self-describing. `pit` can detect a pit worktree by checking for `.pit`.

The `sessionFile` field can be populated after Pi starts (tricky) or left as a pattern to search for.

Add `.pit` to `.gitignore` so it does not get committed into the feature branch.

### Layer 3 — central registry

Maintain a global registry at:

```
~/.pi/pit/registry.json
```

Structure:

```json
{
  "worktrees": [
    {
      "task": "fix-login",
      "branch": "pi/fix-login-20260510-153000",
      "repo": "C:/Users/ricfr/Repos/myrepo",
      "worktree": "C:/Users/ricfr/Repos/myrepo-wt-fix-login-20260510-153000",
      "created": "2026-05-10T15:30:00Z",
      "sessionFile": "..."
    }
  ]
}
```

`pit new` → appends entry
`pit clean` → removes entry
`pit list` → reads from registry (no need to be inside a repo)

Registry entries that point to non-existent worktree dirs are considered stale and shown separately or auto-pruned.

---

## pit list behaviour

With the registry, `pit list` can show:

```
TASK            REPO          BRANCH                          STATUS
fix-login       myrepo        pi/fix-login-20260510-153000    active
write-tests     myrepo        pi/write-tests-20260509-090000  orphaned
refactor-auth   other-repo    pi/refactor-auth-20260508-..    active
```

Status:
- **active** — worktree dir exists
- **orphaned** — registry entry exists but worktree dir is gone (crashed or manually deleted)

---

## pit clean behaviour

Two modes:

1. `pit clean <task>` — clean a specific task by name (fuzzy match against registry)
2. `pit clean --orphaned` — remove all registry entries whose worktree dir no longer exists

---

## Session file linking

The Pi session file for a worktree lives at:

```
~/.pi/agent/sessions/--<worktree-path-encoded>--/<timestamp>_<uuid>.jsonl
```

Since the path encoding is deterministic, `pit` can derive the session bucket dir from the worktree path. The actual session file is whatever `.jsonl` is inside that bucket.

`pit list` could show the session name if one is set.

---

## .pit in .gitignore

The `.pit` marker file should not be committed. `pit` should append `.pit` to the worktree's `.gitignore` (or the repo's `.git/info/exclude`) on creation.

---

## Implementation order

1. Add `.pit` marker file on `pit new`
2. Add `~/.pi/pit/registry.json` read/write on `pit new` and `pit clean`
3. Improve `pit list` to use registry and show status
4. Add `pit clean --orphaned`
5. Add session file resolution to `pit list`

---

## Open questions

- Should `.pit` be committed or ignored? → ignored (local tooling metadata)
- Should the registry live in `~/.pi/pit/` or `~/.pit/` or the agent repo? → `~/.pi/pit/` keeps it with the rest of Pi state
- Should `pit` detect if Pi is actually running in a worktree? → possible via lockfile or process list, deferred for now
