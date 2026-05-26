# Plan: unified branch status footer

## Summary

Replace the two separate footer extensions (`pit-merged`, `pit-loc`) with a single
unified `pit-status` item. Adds staged/unstaged LOC, binary file detection, and
richer contextual display (merge in progress, detached HEAD, no parent branch).

---

## Display format

Segments joined by ` · `. Only non-zero/relevant segments shown.

```
2 commits ahead (+42 −7) · 3 commits behind main · staged (+5) · unstaged (+3 −1)
```

### Segment rules

**Ahead segment** — omitted when `aheadCount === 0`
```
2 commits ahead (+42 −7)          — text + binary
2 commits ahead (+42 −7, 2 binary files)  — mixed
2 commits ahead (2 binary files)  — binary only
2 commits ahead (+0)              — empty/permission-only commits
1 commit ahead (+5)               — singular
```

**Behind segment** — omitted when `behindCount === 0`; no LOC (upstream commits, not ours)
```
3 commits behind main
1 commit behind main              — singular
```

**Staged segment** — omitted when both zero
```
staged (+5)
staged (−3)
staged (+5 −3)
```

**Unstaged segment** — omitted when both zero
```
unstaged (+5)
unstaged (−3)
unstaged (+3 −1)
```

**Special states** — replace ahead/behind segments; staged/unstaged still appended
```
in sync with main                         — 0 ahead, 0 behind, clean
in sync with main · staged (+5)           — 0 ahead, 0 behind, dirty
merge in progress · 2 commits ahead (+42 −7) · 3 commits behind main · staged (+5)
staged (+5) · no parent branch            — no master/main found
staged (+5) · detached HEAD               — detached HEAD, dirty
(hidden)                                  — detached HEAD or no parent, clean
```

### LOC format inside parentheses
Same rules as standalone: `+N −M` / `+N` / `−M`. Unicode minus `\u2212`.

---

## Architecture

### Server: new `branch-status` op

Replaces `is-merged` and `loc-diff`. Runs all necessary git commands and returns
raw outputs where parsing is display-relevant (numstat), resolved primitives where
trivial (counts, booleans).

**Request:** `{ "op": "branch-status" }`

**Response:**
```json
{
  "aheadCount": 2,
  "behindCount": 3,
  "parentBranch": "main",
  "aheadNumstat": "42\t7\tsrc/foo.ts\n-\t-\timage.png\n",
  "stagedNumstat": "5\t0\tsrc/bar.ts\n",
  "unstagedNumstat": "3\t1\tsrc/baz.ts\n",
  "mergeInProgress": false,
  "detachedHead": false
}
```

**Parsing responsibility split:**
- Server resolves: counts (single integer from `rev-list --count`), booleans
  (file-existence checks for MERGE_HEAD, detached HEAD detection), parent branch
  name (requires host filesystem — client can't do this from sandbox)
- Client parses: numstat strings (display-relevant, no security significance)

**Why raw numstat strings:**
- `--shortstat` is localised (breaks on non-English systems); `--numstat` is
  machine-readable and stable across git versions
- Binary files appear as `-\t-\tfilename` in numstat — client needs to count them
- Parsing is purely for display; server has no reason to own it

**Git commands run by the op:**
```
git merge-base HEAD <parent>             →  base SHA
git diff --numstat <base> HEAD           →  aheadNumstat
git rev-list --count <parent>..HEAD      →  aheadCount
git rev-list --count HEAD..<parent>      →  behindCount
git diff --cached --numstat              →  stagedNumstat
git diff --numstat                       →  unstagedNumstat
MERGE_HEAD exists?                       →  mergeInProgress
git symbolic-ref HEAD                    →  detachedHead
detect master/main                       →  parentBranch
```

### Client: two pure functions

**`parseNumstat(stdout: string)`**
```ts
→ { insertions: number, deletions: number, binaryFiles: number }
```
Sums tab-separated integers across lines; counts `-\t-` lines as binary.

**`formatBranchStatus(state: BranchStatusResponse)`**
```ts
→ string | undefined
```
Takes the op response directly (socket contract = test contract). Returns `undefined`
when nothing to show (hidden footer item).

### Extension

Replaces `merge-status.ts` and `loc-diff.ts`. Single call to `useEscapeStatus`
with op `"branch-status"` and status key `"pit-status"`.

---

## Server design note: dumb vs composite ops

Currently the server has composite ops (`is-merged`, `loc-diff`) that coordinate
multiple git calls server-side. `branch-status` continues this pattern for one
reason: **dependency between calls**. `diff --numstat <base>` requires the SHA
from `merge-base HEAD <parent>` — two sequential round trips with a local Unix
socket dependency between them.

For read-only ops, a dumber server (multiple client calls) is worth revisiting
separately. For write ops (`merge-to-parent`, `rename-branch`), server coordination
is correct for atomicity. This split is tracked as a separate concern.

---

## Test plan

### `parseNumstat(stdout)`

| # | Input | Expected output |
|---|-------|----------------|
| 1 | `""` | `{ insertions: 0, deletions: 0, binaryFiles: 0 }` |
| 2 | `"5\t2\tfoo.ts\n"` | `{ insertions: 5, deletions: 2, binaryFiles: 0 }` |
| 3 | `"5\t2\ta.ts\n3\t1\tb.ts\n"` | `{ insertions: 8, deletions: 3, binaryFiles: 0 }` |
| 4 | `"-\t-\timage.png\n"` | `{ insertions: 0, deletions: 0, binaryFiles: 1 }` |
| 5 | `"-\t-\ta.png\n-\t-\tb.png\n"` | `{ insertions: 0, deletions: 0, binaryFiles: 2 }` |
| 6 | `"42\t7\tfoo.ts\n-\t-\timg.png\n"` | `{ insertions: 42, deletions: 7, binaryFiles: 1 }` |
| 7 | `"0\t5\tfoo.ts\n"` | `{ insertions: 0, deletions: 5, binaryFiles: 0 }` |
| 8 | `"5\t0\tfoo.ts\n"` | `{ insertions: 5, deletions: 0, binaryFiles: 0 }` |
| 9 | `"5\t2\tfoo.ts\n"` (trailing newline) | `{ insertions: 5, deletions: 2, binaryFiles: 0 }` |
| 10 | `"5\t2\tfoo.ts\r\n"` (CRLF) | `{ insertions: 5, deletions: 2, binaryFiles: 0 }` |

### `formatBranchStatus(state)` — factory default state

```ts
const s = (overrides = {}) => ({
  aheadCount: 0, aheadInsertions: 0, aheadDeletions: 0, aheadBinaryFiles: 0,
  behindCount: 0, parentBranch: "main",
  stagedInsertions: 0, stagedDeletions: 0,
  unstagedInsertions: 0, unstagedDeletions: 0,
  detachedHead: false, mergeInProgress: false,
  ...overrides,
});
```

Note: `formatBranchStatus` receives the raw op response and calls `parseNumstat`
internally — the factory works over the parsed fields for test clarity.

#### Normal states
| # | Overrides | Expected |
|---|-----------|----------|
| 1 | *(none)* | `"in sync with main"` |
| 2 | `aheadCount:2, aheadInsertions:42, aheadDeletions:7` | `"2 commits ahead (+42 −7)"` |
| 3 | `behindCount:3` | `"3 commits behind main"` |
| 4 | `aheadCount:2, aheadInsertions:42, aheadDeletions:7, behindCount:3` | `"2 commits ahead (+42 −7) · 3 commits behind main"` |
| 5 | `stagedInsertions:5` | `"in sync with main · staged (+5)"` |
| 6 | `unstagedInsertions:3, unstagedDeletions:1` | `"in sync with main · unstaged (+3 −1)"` |
| 7 | `stagedInsertions:5, unstagedInsertions:3, unstagedDeletions:1` | `"in sync with main · staged (+5) · unstaged (+3 −1)"` |
| 8 | `aheadCount:2, aheadInsertions:42, aheadDeletions:7, stagedInsertions:5` | `"2 commits ahead (+42 −7) · staged (+5)"` |
| 9 | `behindCount:3, stagedInsertions:5, unstagedInsertions:3, unstagedDeletions:1` | `"3 commits behind main · staged (+5) · unstaged (+3 −1)"` |
| 10 | `aheadCount:2, aheadInsertions:42, aheadDeletions:7, behindCount:3, stagedInsertions:5, unstagedInsertions:3, unstagedDeletions:1` | `"2 commits ahead (+42 −7) · 3 commits behind main · staged (+5) · unstaged (+3 −1)"` |

#### LOC edge cases
| # | Overrides | Expected |
|---|-----------|----------|
| 11 | `aheadCount:2` | `"2 commits ahead (+0)"` |
| 12 | `aheadCount:2, aheadBinaryFiles:2` | `"2 commits ahead (2 binary files)"` |
| 13 | `aheadCount:2, aheadInsertions:42, aheadDeletions:7, aheadBinaryFiles:2` | `"2 commits ahead (+42 −7, 2 binary files)"` |
| 14 | `stagedInsertions:5` | `"in sync with main · staged (+5)"` |
| 15 | `stagedDeletions:3` | `"in sync with main · staged (−3)"` |
| 16 | `unstagedInsertions:5` | `"in sync with main · unstaged (+5)"` |
| 17 | `unstagedDeletions:3` | `"in sync with main · unstaged (−3)"` |

#### Special states
| # | Overrides | Expected |
|---|-----------|----------|
| 18 | `mergeInProgress:true` | `"merge in progress · in sync with main"` |
| 19 | `mergeInProgress:true, aheadCount:2, aheadInsertions:42, aheadDeletions:7, behindCount:3, stagedInsertions:5, unstagedInsertions:3, unstagedDeletions:1` | `"merge in progress · 2 commits ahead (+42 −7) · 3 commits behind main · staged (+5) · unstaged (+3 −1)"` |
| 20 | `parentBranch:null` | `undefined` |
| 21 | `parentBranch:null, stagedInsertions:5` | `"staged (+5) · no parent branch"` |
| 22 | `detachedHead:true` | `undefined` |
| 23 | `detachedHead:true, stagedInsertions:5` | `"staged (+5) · detached HEAD"` |

#### Singular/plural
| # | Overrides | Expected |
|---|-----------|----------|
| 24 | `aheadCount:1, aheadInsertions:5` | `"1 commit ahead (+5)"` |
| 25 | `aheadCount:2, aheadInsertions:5` | `"2 commits ahead (+5)"` |
| 26 | `behindCount:1` | `"1 commit behind main"` |
| 27 | `behindCount:2` | `"2 commits behind main"` |
| 28 | `aheadCount:1, aheadBinaryFiles:1` | `"1 commit ahead (1 binary file)"` |
| 29 | `aheadCount:1, aheadBinaryFiles:2` | `"1 commit ahead (2 binary files)"` |

#### Consistency
| # | Overrides | Expected |
|---|-----------|----------|
| 30 | `parentBranch:"master", behindCount:3` | `"3 commits behind master"` |
| 31 | `parentBranch:"develop", aheadCount:1, aheadInsertions:5` | `"1 commit ahead (+5) · in sync with develop"` — wait, this needs thought |

---

## Open questions

1. **Case 18 display**: when merge in progress and 0 ahead/behind — show
   `"merge in progress · in sync with main"` or just `"merge in progress"`?
   Currently planned as the former for context.

2. **Server refactor (read ops)**: the dumb-server direction (multiple client
   calls for read-only ops) is worth pursuing separately. `branch-status` keeps
   server coordination for now due to the merge-base dependency chain.

3. **Deprecation of `is-merged` and `loc-diff` ops**: once `branch-status` ships,
   these can be removed from the server. Tracked here to not forget.
