# Pit Session States — Current Behaviour

Reference table for all combinations of session state, git state, and metadata state.

**Picker: Current folder** = running `pit -r` from inside the same git repo (main tree or any sibling worktree).  
**Picker: All folders** = all sessions regardless of context.  
**Linked session** = created via `findOrCreateLinkedSession` when already inside a git worktree (`mode:no-tree`, `branch:""`).  
**Stale: handoff** = session cwd was moved here but pit metadata still carries `mode:worktree` from the original worktree.

| `sessionCwd` | Metadata | Picker: Current folder | Picker: All folders | Open: CWD | Open: Sandbox | Open: Recreated | Open: System Prompt |
|---|---|---|---|---|---|---|---|
| Exists (Worktree, pit session) | Valid | `[branch:X]` | shown | ✓ `sessionCwd` | Yes | — | `worktree mode, branch: pi/X` |
| Exists (Worktree, pit session) | Stale: branch renamed | `[branch:X]` | shown | ✓ `sessionCwd` | Yes | — | `worktree mode, branch: pi/X (old name)` |
| Exists (Worktree, linked session) | Valid/Stale | `[branch:X]` | shown | ✓ `sessionCwd` | Yes | — | `no-tree: already in a worktree` |
| Exists (Worktree, any) | Missing | `[branch:X]` | shown | ✗ `process.cwd()` | Yes, wrong dir | — | — |
| Exists (Main Repo) | Valid | shown, no label | shown | ✓ `sessionCwd` | Yes | — | `no-tree: --nt flag` |
| Exists (Main Repo) | Stale: handoff | shown, no label | shown | ✓ `sessionCwd` | Yes | — | `worktree mode, branch: pi/X (stale)` |
| Exists (Main Repo) | Missing | shown, no label | shown | ✗ `process.cwd()` | Yes, wrong dir | — | — |
| Exists (Non-Repo) | Valid | not shown | shown | ✓ `sessionCwd` | Yes | — | `no-tree: no git repo` |
| Exists (Non-Repo) | Stale: handoff | not shown | shown | ✓ `sessionCwd` | Yes | — | `worktree mode, branch: pi/X (stale)` |
| Exists (Non-Repo) | Missing | not shown | shown | ✗ `process.cwd()` | Yes, wrong dir | — | — |
| Missing | Unpruned, branch exists · Valid | `[branch:deleted]` | shown | ✓ `sessionCwd` (recreated) | Yes | **Yes** | `worktree mode, branch: pi/X` |
| Missing | Unpruned, branch exists · Stale | `[branch:deleted]` | shown | Fails — git error | N/A | — | N/A |
| Missing | Unpruned, branch exists · Missing | `[branch:deleted]` | shown | ✗ `process.cwd()` → dialog | Yes, wrong dir | — | — |
| Missing | Unpruned, branch deleted · Valid | `[branch:deleted]` | shown | Fails — WorktreeMissingError | N/A | — | N/A |
| Missing | Pruned, branch exists · Valid | not shown | shown | ✓ `sessionCwd` (recreated) | Yes | **Yes** | `worktree mode, branch: pi/X` |
| Missing | Pruned, branch exists · Stale/Missing | not shown | shown | Fails | N/A | — | N/A |
| Missing | Never a repo · Any | not shown | shown | ✗ `process.cwd()` → dialog | Yes, wrong dir | — | — |
