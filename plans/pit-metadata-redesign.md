# Plan: pit session metadata redesign

## What's changing and why

`PitMetadata` in the session file currently stores several fields that are
either derivable at launch time or unused. This plan cleans that up.

---

## PitMetadata after

```ts
interface PitMetadata {
  repo:   string;   // main repo path — cache, refreshed from git on launch
  branch: string;   // checked-out branch — cache, refreshed from git on launch
}
```

### Fields removed

| Field | Reason |
|---|---|
| `id` | Only used for escape socket name. Socket moves to session UUID (see below). |
| `created` | Never read anywhere. Dead weight. |
| `mode` | Derived at launch: `isLinkedWorktree(cwd)`. For the missing-worktree recovery case, inferred from `branch !== ""`. |
| `noTreeReason` | Derived fresh on every launch from git state + `--nt` flag. User intent at a past launch is irrelevant on resume. |

### Fields kept (as caches)

`repo` and `branch` are the only fields that can't be read when the worktree
directory is gone. Both are cached so worktree recreation still works even if
the directory was deleted.

**Cache refresh:** at every resume when the worktree directory exists (worktree-mode
sessions only — no-tree sessions have `branch: ""` and nothing to refresh), pit reads
fresh values from git and rewrites the pit entry line if either value changed. The
rewrite happens before pi starts so there is no concurrent writer. Old fields are
naturally stripped at this point.

---

## Escape server

### Socket name

`pit-${sessionUUID}.sock` instead of `pit-${pitId}.sock`.  
Session UUID is read from the session file header at launch; no separate id field needed.

### When to start

Start whenever running in **sandbox mode** (bwrap is active), regardless of
whether the cwd is a linked worktree or not. The current `isLinkedWorktree`
gate is removed.

Rationale: sandbox and escape are orthogonal to tree mode. Merge/diff commands
work as long as there is a parent branch — no requirement to be inside a linked
worktree.

---

## Mode footer (new feature)

Show pit mode and sandbox status in the pi status bar on every session start,
including when not in tree mode or not sandboxed.

Examples:
- `[worktree: pi/80096d01] [sandbox]`
- `[no-tree] [sandbox]`
- `[worktree: pi/80096d01] [no sandbox]`
- `[no-tree] [no sandbox]`

Implementation: pit extension `session_start` handler calls
`ctx.ui.setStatus("pit-mode", ...)` and `ctx.ui.setStatus("pit-sandbox", ...)`.
Mode is derived from `isLinkedWorktree(cwd)` + branch; sandbox from whether
bwrap is active (passed in via extension factory args or env var).

---

## System prompt

Pit only communicates sandbox status to the agent via `--append-system-prompt`.
All git context (branch, worktree mode, no-tree reason) is derivable by the
agent from git tools — pit does not repeat it.

The mode footer (`pit-mode`, `pit-sandbox` status bar items) handles
human-visible mode display separately.

---

## Backward compatibility

Old sessions carry extra fields (`id`, `created`, `worktree`, `mode`,
`noTreeReason`) alongside `repo` and `branch`. New code only reads `repo`
and `branch` — extra fields are silently ignored. Old sessions open without
any migration step.

`repo` and `branch` were never optional in the old format, so there is no
fallback case to handle.

The stale `worktree` field in old pit entries (the handoff bug) is harmless:
new code reads the session cwd from the session header, not from the pit entry.

If `repo` or `branch` happen to be stale on resume, the cache-refresh rewrite
will naturally produce a slim entry as a side effect. This is not a migration
strategy — old entries that aren't stale are never rewritten.

---

## Logic flow (high level)

### New session

```
parse flags
  → determine if worktree should be created (git repo present, not forced no-tree)
  → create worktree OR run no-tree in current dir
write session file  (header + pit entry + announcement)
start escape server if sandbox
launch pi
  → extension sets mode/sandbox footer on session start
```

### Resume (pit -r)

```
show session picker (TUI)
  → user selects session
  → picker reads branch label from live git data (git worktree list + metadata.repo)
  → picker updates metadata if branch label is stale

if worktree-mode session and directory exists:
  → read branch/repo fresh from git
  → rewrite pit entry if stale
  → if isLinkedWorktree(cwd) = false but branch ≠ "": warn in picker (⚠), still openable

if worktree-mode session and directory missing:
  → if branch exists in git: recreate worktree (git worktree add)
  → if branch missing from git but known from metadata:
      TUI prompt: "branch pi/X no longer exists — create fresh off main?"
      → yes: git branch pi/X <main HEAD>, git worktree add → launch
      → no: abort
  → if no metadata and inside repo: derive branch from git worktree list, then recreate
  → if unrecoverable (no metadata, outside repo, or pruned+no metadata): pi dialog

if no-tree session:
  → use session cwd as-is

always: chdir to session cwd after recovery concludes
start escape server if sandbox
launch pi with existing session file
  → sandbox mounts process.cwd() (= session cwd post-recovery)
  → extension sets mode/sandbox footer on session start
```

### Already inside a worktree

```
detect: cwd is a linked worktree
find existing pit session for this cwd, or create a new one
  → if resuming: refresh cache if stale (same as resume path)
start escape server if sandbox
launch pi
  → extension sets mode/sandbox footer on session start
```

### Announcement (generated fresh on every launch, nothing read from session)

```
check git state of cwd → worktree or no-tree
if no-tree: check why (no repo / forced by flag / already in a worktree)
build text from mode + reason + sandbox mounts
pass to pi as --append-system-prompt
```

---

## Implementation order

1. Metadata cleanup (`PitMetadata` → `{ repo, branch }`, backward compat)
2. Fix session open CWD (always use `sm.getCwd()`, fix sandbox dir)
3. Picker changes (2.1 discovery, 2.2 live labels, 2.3 worktree isolation, 2.4 warning)
4. Branch-deleted TUI prompt (fresh branch off main)
5. Escape socket → session UUID
6. System prompt → sandbox only
7. Mode footer
8. Branch refresh via escape server ref-change (1.1)
