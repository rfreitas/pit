# Plan: pit worktree UX improvements

Two related improvements to how pit handles worktree directories.

---

## 1 — Don't create a nested worktree when already inside one

### Problem

Running `pit` from inside an existing pit worktree (e.g. `/repos/agent-wt-eb1c0541`) creates
a second worktree off that worktree's branch. This is almost never what you want. The user is
already isolated; they want to continue working there, not nest further.

### Detection

Branch name is the wrong signal — it's just a convention, not a structural fact. Renaming the
branch, detaching HEAD, or using a different naming scheme would all break it.

**The right signal is a git invariant:** a linked worktree always has `.git` as a _file_
(not a directory). The main checkout always has `.git` as a directory. This is enforced by
git itself and is true regardless of branch name, pit version, or anything else.

The `.git` file content is `gitdir: <path>`. The path distinguishes two `.git`-as-file cases:
- **Linked worktree:** `gitdir: /repo/.git/worktrees/<name>` — contains `/worktrees/`
- **Submodule:** `gitdir: ../.git/modules/<name>` — contains `/modules/`

So the check is:

```ts
function isLinkedWorktree(cwd: string): boolean {
  try {
    const gitPath = path.join(cwd, ".git");
    if (fs.statSync(gitPath).isDirectory()) return false;
    const gitdir = fs.readFileSync(gitPath, "utf8").trim().replace(/^gitdir:\s*/, "");
    return gitdir.includes("/.git/worktrees/");
  } catch { return false; }
}
```

No branch name, no pattern matching, no pit-specific knowledge — pure git structure.

### Proposed behaviour

In `worktreeCheck` (new-session path), before doing anything git-related:

1. Call `isLinkedWorktree(cwd)`.
2. **If false** → proceed as today (create worktree or no-tree).
3. **If true**, look for the most recent pit session for this cwd:
   - Call `SessionManager.list(cwd)`, open each result with `SessionManager.open`,
     scan entries for `customType === "pit"`.
   - If found → resume that session (same path as `pit -r` picking it).
   - If not found (user's own worktree, or session was deleted) → fall through to
     no-tree mode with a message: `pit: already in a git worktree — running no-tree`.

This also correctly handles non-pit linked worktrees (user ran `git worktree add` manually):
we still don't nest, we just go no-tree.

**Why auto-resume rather than just no-tree?** If you `cd` into a worktree and run `pit`, you want
to continue the work that lives there. Silently creating a new session and dropping context would
be surprising. Auto-resuming the existing session is the natural outcome.

**Edge case — user wants a fresh session in an existing worktree.** They can pass `-nt` or 
`--no-session`. We should respect `--no-session` and start a new no-tree session without resuming.

### Change surface

- `utils.ts` — add `isLinkedWorktree(cwd)` and `findPitSession(cwd, agentDir)` (pure, testable).
- `pit.ts` — `worktreeCheck` calls the two new helpers before `gitRepoRoot()`.

### Testing strategy

The two new functions land in `utils.ts`, which means they're directly importable — no
subprocess or mocking needed.

#### `isLinkedWorktree` — fake filesystem, no real git required

The function only reads `.git`. We can fake every case by writing files into temp dirs:

```
case                    .git shape              expected
──────────────────────────────────────────────────────
non-git dir             absent                  false
main checkout           directory               false
submodule               file, path has /modules/ false
linked worktree         file, path has /worktrees/ true
linked worktree (abs)   file, absolute path     true
```

All five cases are writable as synchronous temp-dir tests, zero git commands.

```ts
// Minimal linked-worktree fake:
fs.writeFileSync(path.join(dir, ".git"),
  "gitdir: /home/user/repo/.git/worktrees/wt-abc\n");
expect(isLinkedWorktree(dir)).toBe(true);

// Submodule fake:
fs.writeFileSync(path.join(dir, ".git"),
  "gitdir: ../.git/modules/sub\n");
expect(isLinkedWorktree(dir)).toBe(false);
```

These go in `unit.test.ts` alongside the existing pure-function tests.

#### `findPitSession` — real session files, no real git required

The function reads the sessions directory and opens JSONL files. It uses the same
`SessionManager.list` + `SessionManager.open` path that `pit -r` uses. The existing
`setupNewSession` helper already creates real, pi-compatible session files in a temp
agentDir — we can reuse it directly:

```
scenario                                         expected
──────────────────────────────────────────────────────
no sessions in dir                               null
sessions exist, none are pit                     null  (unlikely but guard it)
one pit session                                  returns its meta
multiple pit sessions                            returns the most recent one
```

These go in a new `pit/tests/worktree-detection.test.ts` to keep the session-file
based tests separate from the pure unit tests.

#### What is NOT tested (and why)

`worktreeCheck` in `pit.ts` is thin glue: it calls the two new utils, then calls
existing git commands and the already-tested `setupNewSession`. The orchestration
itself is not worth testing — the risk lives in the two new functions, which are
covered above. This matches the existing pattern (the existing tests cover utils,
not `worktreeCheck` itself).

### What does NOT change

The sandbox and git-helper setup. Those are keyed on `result.cwd` and `result.meta`, so they
work identically on resume.

---

## 2 — `pit -r` shows sessions for the current repo AND all its worktrees

### Problem

`pit -r` from `/repos/agent` shows only sessions whose CWD was `/repos/agent`.  
Sessions in `/repos/agent-wt-*` are in separate bucket directories under
`~/.pi/agent/sessions/` and are hidden from the picker.

Pi's path-based filtering is by design: `SessionManager.list(cwd)` reads the directory named
`--<cwd-encoded>--`. There is no native concept of "sessions for this repo and all its
worktrees".

### Why it matters

The natural workflow is to start several pit sessions from the same repo and later use
`pit -r` to pick one up. With the current filtering you have to use the "all sessions" tab
(Tab 2) and hunt by name. The worktree sessions should appear in the primary list.

### Approach: enumerate worktrees, merge SessionManager.list calls

`SessionSelectorComponent` accepts two loader callbacks:

```ts
type SessionsLoader = (onProgress?: SessionListProgress) => Promise<SessionInfo[]>;

new SessionSelectorComponent(
  currentSessionsLoader,   // Tab 1 — "current"
  allSessionsLoader,       // Tab 2 — "all"
  ...
)
```

`SessionManager.list(path)` accepts any path — we can call it once per worktree.
`SessionInfo` contains a `sessionFile` path, which is globally unique, so merging
and deduplicating by that field is safe.

**Implementation of the merged loader:**

```ts
async function makeWorktreeLoader(repoRoot: string): Promise<SessionsLoader> {
  // Enumerate worktrees synchronously (fast, local git)
  // git -C <repo> worktree list --porcelain
  // Parse → collect paths whose branch matches pi/<hex>
  const worktreePaths = listPitWorktrees(repoRoot); // ["…-wt-abc", "…-wt-def"]
  const allPaths = [repoRoot, ...worktreePaths];

  return async (onProgress) => {
    const results = await Promise.all(
      allPaths.map((p) => SessionManager.list(p, undefined, onProgress).catch(() => []))
    );
    // Deduplicate by sessionFile path
    const seen = new Set<string>();
    return results.flat().filter((s) => {
      if (seen.has(s.sessionFile)) return false;
      seen.add(s.sessionFile);
      return true;
    });
  };
}
```

`listPitWorktrees` parses `git worktree list --porcelain` output:

```ts
function listPitWorktrees(repo: string): string[] {
  try {
    const out = execSync(`git -C ${repo} worktree list --porcelain`, { encoding: "utf8" });
    const paths: string[] = [];
    let currentPath = "";
    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) currentPath = line.slice(9).trim();
      else if (line.startsWith("branch refs/heads/pi/") && currentPath && currentPath !== repo)
        paths.push(currentPath);
    }
    return paths;
  } catch { return []; }
}
```

This is pure git, no session scanning, runs in <10 ms even with many worktrees.

### Fallback for non-git / outside a repo

If `gitRepoRoot()` returns null, `showPicker` falls back to `SessionManager.list(cwd)` as today.
No behaviour change for non-repo use.

### How the tabs look after this change

| Tab | Content |
|---|---|
| **Current** (Tab 1) | Sessions from `<repo>` + all `<repo>-wt-*` dirs |
| **All** (Tab 2) | Everything (unchanged) |

The worktree sessions in Tab 1 will naturally carry the worktree path as their CWD label, so it's
still easy to tell which is which. No UI change needed.

### Change surface

- `pit.ts` — `showPicker` builds the merged loader via `makeWorktreeLoader` when inside a git repo.
- `utils.ts` — add `listPitWorktrees(repo)` (pure, testable).
- Tests — cover: repo with 0/1/N pit worktrees, non-git dir, dedup of same session appearing via
  two paths (shouldn't happen but guard it).

### Alternative considered: scan all sessions client-side

`SessionManager.listAll()` then filter by `meta.repo === cwd`. This avoids git entirely but
requires opening every session file to read pit metadata — potentially slow with many sessions.
The worktree enumeration approach is strictly faster and only fetches what's relevant.

### Alternative considered: pi API path aliasing

Checked `SessionManager` type surface — there is no way to register additional CWD aliases or
override the bucket logic. The multi-call + merge approach is the only one that works with the
current public API.

---

## Implementation order

1. **Feature 1 first** (detection is self-contained, no new public API surface).  
2. **Feature 2 second** (`isLinkedWorktree` from Feature 1 is useful context; `listPitWorktrees` is new but builds on the same `.git`-file understanding).

Both changes are backward-compatible. Existing sessions and non-worktree use are unaffected.
