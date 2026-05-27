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

**Cache refresh:** at every launch when the worktree exists, pit reads fresh
values from git (`rev-parse --abbrev-ref HEAD`, `rev-parse --show-toplevel`)
and rewrites the session file if either value changed. The rewrite happens
before pi starts so there is no concurrent writer.

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

## Announcement text (`buildAnnouncement`)

All inputs derived fresh on every launch — nothing read from stored metadata.
`buildAnnouncement(cwd, mode, noTreeReason, sandboxMounts)` replaces
`buildAnnouncement(meta, cwd, sandboxMounts)`.

`noTreeReason` is computed at launch time from: `isLinkedWorktree(cwd)`,
`gitRepoRoot()`, and the `--nt` flag. Not stored, not read from session.

---

## Open questions

- None blocking. Implementation order: metadata → escape socket → footer.
