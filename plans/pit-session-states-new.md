# Pit Session States — New Desired Behaviour

Reference table for all combinations under the redesigned pit.

**Current folder (from main repo):** sessions for main + all worktrees via `git worktree list` + `metadata.repo`, deduplicated.  
**2.3:** When invoked from a worktree, Current folder shows only that worktree's own sessions.  
**⚠ Warning:** `sessionCwd` exists, `isLinkedWorktree` = false, but `metadata.branch ≠ ""` (2.4). Still openable.  
**✦ Fixed:** was `process.cwd()` (wrong dir) in current design.  
**★ Improved:** pruned sessions now discoverable via `metadata.repo` scan — previously only accessible via All folders.  
**TUI prompt:** when branch is deleted, pit shows a TUI confirmation before launching — offers to create a fresh branch off main with the same name. Session history (conversation) is preserved; only the git state starts fresh.

| `sessionCwd` | Metadata | Picker: Current folder | Picker: All folders | Open: CWD | Open: Sandbox | Open: Recreated | Open: System Prompt |
|---|---|---|---|---|---|---|---|
| Exists (Worktree, pit session) | Valid | `[branch:X]` | shown | ✓ `sessionCwd` | Yes | — | sandbox |
| Exists (Worktree, pit session) | Stale: branch renamed | `[branch:new-name]` (live git, meta updated) | shown | ✓ `sessionCwd` | Yes | — | sandbox |
| Exists (dir, not linked) | branch in metadata | `[branch:deleted]` ⚠ | shown ⚠ | ✓ `sessionCwd` | Yes | — | sandbox |
| Exists (Worktree, linked session) | Valid/Stale | `[branch:X]` | shown | ✓ `sessionCwd` | Yes | — | sandbox |
| Exists (Worktree, any) | Missing | `[branch:X]` | shown | ✓ `sessionCwd` ✦ | Yes | — | sandbox |
| Exists (Main Repo) | Valid | shown, no label | shown | ✓ `sessionCwd` | Yes | — | sandbox |
| Exists (Main Repo) | Stale: handoff | shown, no label ⚠ | shown ⚠ | ✓ `sessionCwd` | Yes | — | sandbox |
| Exists (Main Repo) | Missing | shown, no label | shown | ✓ `sessionCwd` ✦ | Yes | — | sandbox |
| Exists (Non-Repo) | Valid | not shown | shown | ✓ `sessionCwd` | Yes | — | sandbox |
| Exists (Non-Repo) | Stale: handoff | not shown ⚠ | shown ⚠ | ✓ `sessionCwd` | Yes | — | sandbox |
| Exists (Non-Repo) | Missing | not shown | shown | ✓ `sessionCwd` ✦ | Yes | — | sandbox |
| Missing | Unpruned, branch exists · Valid | `[branch:deleted]` | shown | ✓ `sessionCwd` (recreated) | Yes | **Yes** | sandbox |
| Missing | Unpruned, branch exists · Stale | `[branch:deleted]` | shown | Fails — git error | N/A | — | N/A |
| Missing | Unpruned, branch exists · Missing | `[branch:deleted]` | shown | ✗ → pi dialog | Yes, `process.cwd()` | — | — |
| Missing | Unpruned, branch deleted · Valid | `[branch:deleted]` | shown | TUI prompt → yes: ✓ `sessionCwd` (fresh branch off main); no: abort | Yes (if yes) | **Yes** | sandbox |
| Missing | Pruned, branch exists · Valid | shown via metadata ★ | shown | ✓ `sessionCwd` (recreated) | Yes | **Yes** | sandbox |
| Missing | Pruned, branch exists · Stale/Missing | shown via metadata | shown | Fails — git error (stale) / TUI prompt → fresh branch (missing) | Yes (if prompt yes) | **Yes** (if prompt yes) | sandbox |
| Missing | Never a repo · Any | not shown | shown | ✗ → pi dialog | Yes, `process.cwd()` | — | — |
