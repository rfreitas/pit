# Test audit: findings (pit)

**Investigation completed: 2026-06-04. See [test-audit.md](test-audit.md) for the reusable approach.**

## Scope

33 test files across `pit/src/` (unit) and `pit/tests/` (integration).

Phase 1 of `bwrap-platform-mounts.md` already fixed the most acute case: 11 test
sites had hand-rolled bwrap args instead of importing `buildBwrapArgs`. This
document covers the remaining duplication.

## Categories found

### 1. Git repo creation

| Central source | Local copies |
|---|---|
| `pit/src/tests/helpers.ts` — `makeGitRepo(makeTmp)` | `pit/tests/e2e.test.ts`, `worktree-check.test.ts`, `worktree-detection.test.ts` |

**Variation:** init flag (`-b main` vs bare `init`), first file name
(`.gitkeep` vs `dummy.txt`), verbosity (`-q` vs `stdio: "ignore"`),
branch name default.

**Fix:** Parameterize `makeGitRepo` with an options bag (`branch`, `file`,
`quiet`). Add a sync version `makeGitRepoSync()` that manages its own tmp
dir cleanup for non-Effect tests.

### 2. Tmp directory lifecycle

| Central source | Local copies |
|---|---|
| `pit/src/tests/helpers.ts` — `useTmpDirs()` → `{ makeTmp, makeSandbox }` | `pit/tests/resume.test.ts` (`makeTmpDir`) · `pit/tests/sandbox.test.ts` (`makeTmpDir`) · `pit/tests/worktree-check.test.ts` (`makeTmp`) · `pit/tests/worktree-detection.test.ts` (`makeTmpDir`) · `pit/src/core/session/sync-branch.test.ts` (`makeTmp`) · `pit/src/extensions/status/mode.test.ts` (`makeTmp`) · `pit/tests/e2e.test.ts` (manual `mkdtempSync` + cleanup arrays) · `pit/tests/linked-worktree-session.test.ts` (`makeDir`) · `pit/tests/picker-e2e-tui.test.ts` (manual single dir) |

**Variation:** Base dir (`os.tmpdir()` vs `TEST_SANDBOX` vs `/tmp`),
cleanup strategy (effect-based `afterEach` vs cleanup array vs manual
`rmSync` at test end).

**Fix:** Add a sync helper `useTmpDirsSync()` that works outside Effect —
returns `{ makeTmp, cleanup }` so `afterEach` can call it directly without
effect machinery. Standardise base dir to `os.tmpdir()` (E2E tests already
do this; `/tmp` in sandbox.test.ts is hardcoded but works).

### 3. Bwrap availability checks

| Central source | Local copies |
|---|---|
| `pit/src/launcher.ts` — `findBwrap()` | `pit/tests/resume.test.ts` (`bwrapCanUnshareUser`) · `pit/tests/sandbox.test.ts` (`bwrapCanUnshareUser`) · `pit/debug/bwrap-optional-mount-probe.test.ts` (`bwrapWorks`) |

**Variation:** `bwrapCanUnshareUser` tests `--unshare-user` flag behavior
(bwrap --version ≥ 0.3). `bwrapWorks` only checks binary existence.

**Fix:** Keep `bwrapCanUnshareUser` as a shared helper in `helpers.ts` since
multiple tests need the `--unshare-user` capability check. The probe file
can keep `bwrapWorks` — it's a debug probe with intentionally minimal
dependencies.

### 4. Sandbox overlay detection

| Central source | Local copies |
|---|---|
| None | `pit/tests/sandbox.test.ts` (`bwrapSupportsOverlay`) — tests bwrap's overlayfs support |

**Fix:** Not duplicated — only used in one file. Keep as-is.

### 5. Escape mock server

| Central source | Local copies |
|---|---|
| None | `pit/src/escape/server.test.ts` · `pit/tests/git.test.ts` · `pit/src/extensions/commands/rename-branch/rename-branch.test.ts` · `pit/src/extensions/tools/git.test.ts` |

**Variation:** Four files each spin up a mock Unix socket server with
different request/response shapes. `startMockEscape` exists in both
`rename-branch.test.ts` and `git.test.ts` with different signatures.

**Decision:** **Defer.** These test different pit-escape operations
(merge-to-parent vs rename-branch vs get-commits) with different
request/response contracts. The mock server *infrastructure* could be
shared, but each test's *handler* is domain-specific. Low-value, high-churn.

### 6. Git worktree helpers

| Central source | Local copies |
|---|---|
| None | `pit/tests/worktree-detection.test.ts` (`addWorktree`) · `pit/src/extensions/status/mode.test.ts` (`makeLinkedWorktree`) · `pit/src/core/session/sync-branch.test.ts` (`makeLinkedWorktree`) · `pit/src/escape/server.test.ts` (`createWorktree`, `initGitRepo`, `addCommit`) |

**Variation:** Some create linked worktrees; others create detachable
worktrees. Different git args, different cleanup strategies.

**Fix:** Extract `makeLinkedWorktree(repo, branch, worktreePath)` and
`makeDetachedWorktree(repo, branch, worktreePath)` to `helpers.ts` as
sync utilities.

### 7. Session file factories

| Central source | Local copies |
|---|---|
| None | `pit/src/resume.test.ts` (`makeWorktreeSession`) · `pit/src/picker.test.ts` (`writeSessionFile`) · `pit/tests/linked-worktree-session.test.ts` (inline) · `pit/tests/picker-integration.test.ts` (`writeSessionFixture`) |

**Variation:** Different session shapes (with/without pit entry, old-format
vs new-format). `makeWorktreeSession` uses `setupNewSession` — that's app
code, not duplicated. The others hand-write JSONL directly with different
field sets.

**Fix:** Add `writeSessionFile(sessionFile, { cwd, worktree, branch })` to
`helpers.ts`. Keep the specialised old-format session writers in
`resume.test.ts` — they're testing backward compat, which by definition
needs old-format data.

### 8. Pi mock helpers

| Central source | Local copies |
|---|---|
| None | `pit/src/extensions/status/mode.test.ts` · `pit/src/extensions/tools/git.test.ts` · `pit/src/extensions/commands/rename-branch/rename-branch.test.ts` · `pit/tests/git.test.ts` · `pit/src/extensions/index.test.ts` |

**Variation:** Each test builds a slightly different mock ExtensionAPI
object. Some return tool-formatted strings; others capture status writes.

**Fix:** Add a minimal `makeMockPi(overrides)` to a common test-utils file.
Already has `makeMockPi` in 4 files — de-duplicate to one source.

## Proposal tables

Each test file with duplicated app code, mapped to its fix.

### Tmp dir helpers (9 files)

| Test file | Feature | App code duplicated | Curr. level | Curr. mocks | Proposed level | Fix | Proposed mocks |
|---|---|---|---|---|---|---|---|
| `pit/tests/e2e.test.ts` | Worktree + agent dir creation | Dir lifecycle (mkdtemp + cleanup arrays) | E2E | `spawnSync` (pit itself) | E2E | Add `makeTmpSync(prefix)` to `helpers.ts`; replace manual `mkdtempSync` + cleanup arrays | `spawnSync` (unchanged) |
| `pit/tests/resume.test.ts` | Session resume in bwrap | `makeTmpDir()` wrapper around `mkdtempSync` | Integration | None (real bwrap) | Integration | Import `makeTmpSync` from helpers; drop local definition | None (unchanged) |
| `pit/tests/sandbox.test.ts` | Sandbox mount behaviour | `makeTmpDir()` hardcoded to `/tmp` | Integration | None (real bwrap) | Integration | Import `makeTmpSync` from helpers | None (unchanged) |
| `pit/tests/worktree-check.test.ts` | Worktree lifecycle with git | `makeTmp(prefix)` calling `mkdtempSync` | Integration | None (real git) | Integration | Already uses `useTmpDirs` but locally redefines `makeTmp`; consolidate to helpers | None (unchanged) |
| `pit/tests/worktree-detection.test.ts` | Worktree detection in parent repo | `makeTmpDir(prefix)` | Integration | None (real git) | Integration | Import `makeTmpSync` from helpers | None (unchanged) |
| `pit/tests/linked-worktree-session.test.ts` | Session file for linked worktrees | `makeDir(prefix)` | Integration | None (real git) | Integration | Import `makeTmpSync` from helpers | None (unchanged) |
| `pit/src/core/session/sync-branch.test.ts` | Branch sync helper | `makeTmp(prefix)` + `makeLinkedWorktree` | Unit | `vi.mock` (spawnSync) | Unit | Import `makeTmpSync` from helpers; local `makeLinkedWorktree` stays (specific to this test's fixtures) | `vi.mock` (unchanged) |
| `pit/src/extensions/status/mode.test.ts` | Mode detection extension | `makeTmp(prefix)` + `makeLinkedWorktree` | Unit | `vi.mock` (spawnSync, fs) | Unit | Import `makeTmpSync` from helpers | `vi.mock` (unchanged) |
| `pit/tests/picker-e2e-tui.test.ts` | Picker TUI (single dir) | Single `mkdtempSync` call | E2E | `vi.mock` (some pi SDK) | E2E | Import `makeTmpSync` from helpers (even for single dir — consistent cleanup) | `vi.mock` (unchanged) |

### Git repo creation (3 files)

| Test file | Feature | App code duplicated | Curr. level | Curr. mocks | Proposed level | Fix | Proposed mocks |
|---|---|---|---|---|---|---|---|
| `pit/tests/e2e.test.ts` | E2E pit launch with repos | `makeGitRepo(tmpDirs)` — init, config, commit | E2E | `spawnSync` (pit) | E2E | Import `makeGitRepoSync()` from helpers; drop local definition | `spawnSync` (unchanged) |
| `pit/tests/worktree-check.test.ts` | Worktree check with git | `makeGitRepo()` — init, config, commit with `-q` | Integration | None (real git) | Integration | Import `makeGitRepoSync()` from helpers; add `{ verbose: false }` option | None (unchanged) |
| `pit/tests/worktree-detection.test.ts` | Worktree detection | `makeGitRepo()` — init, config, commit | Integration | None (real git) | Integration | Import `makeGitRepoSync()` from helpers | None (unchanged) |

### Bwrap availability (2 files)

| Test file | Feature | App code duplicated | Curr. level | Curr. mocks | Proposed level | Fix | Proposed mocks |
|---|---|---|---|---|---|---|---|
| `pit/tests/resume.test.ts` | Resume in bwrap | `bwrapCanUnshareUser()` — spawns bwrap `--version` | Integration | None (real bwrap) | Integration | Move to `helpers.ts` as `bwrapSupportsUnshareUser()`; import in both files | None (unchanged) |
| `pit/tests/sandbox.test.ts` | Sandbox mount overlay | `bwrapCanUnshareUser()` — same function | Integration | None (real bwrap) | Integration | Same as above | None (unchanged) |

### Git worktree helpers (3 files + probe)

| Test file | Feature | App code duplicated | Curr. level | Curr. mocks | Proposed level | Fix | Proposed mocks |
|---|---|---|---|---|---|---|---|
| `pit/tests/worktree-detection.test.ts` | Worktree detection | `addWorktree(repo, branch)` — `git worktree add` | Integration | None (real git) | Integration | Move `addWorktree` to `helpers.ts`; import | None (unchanged) |
| `pit/src/extensions/status/mode.test.ts` | Mode detection | `makeLinkedWorktree(cwd, branch, mainRepo)` | Unit | `vi.mock` (spawnSync) | Unit | Import `addLinkedWorktree` from helpers; drop local definition | `vi.mock` (unchanged) |
| `pit/src/core/session/sync-branch.test.ts` | Branch sync | `makeLinkedWorktree(cwd, branch, mainRepo)` | Unit | `vi.mock` (spawnSync) | Unit | Same as above | `vi.mock` (unchanged) |
| `pit/src/escape/server.test.ts` | Escape server worktree ops | `initGitRepo`, `addCommit`, `createWorktree` | Integration | None (real server spawn) | Integration | Move `createWorktree` to helpers; `initGitRepo` and `addCommit` stay (domain-specific to escape test) | None (unchanged) |

### Pi mock helpers (5 files)

| Test file | Feature | App code duplicated | Curr. level | Curr. mocks | Proposed level | Fix | Proposed mocks |
|---|---|---|---|---|---|---|---|
| `pit/src/extensions/status/mode.test.ts` | Mode footer | `makeMockApi()` — hand-builds `ExtensionAPI` | Unit | `vi.mock` (spawnSync, fs) | Unit | Import `makeMockPi(overrides)` from shared test-utils | `vi.mock` (unchanged) |
| `pit/src/extensions/tools/git.test.ts` | Git tool extension | `makeMockPi()` — hand-builds `ExtensionAPI` | Unit | `vi.mock` (escape client) | Unit | Same as above | `vi.mock` (unchanged) |
| `pit/src/extensions/commands/rename-branch/rename-branch.test.ts` | Rename-branch command | `makeMockPi()`, `makeMockCtx()` | Unit | `vi.mock` (escape client) | Unit | Import `makeMockPi` + `makeMockToolContext` from shared test-utils | `vi.mock` (unchanged) |
| `pit/tests/git.test.ts` | Git tool integration | `makeMockPi()` — hand-builds `ExtensionAPI` | Integration | None (real escape server) | Integration | Same as above | None (unchanged) |
| `pit/src/extensions/index.test.ts` | Extension factories | `makeMockPi()` + `makeMockPiWithStatusCapture()` | Unit | None | Unit | Import `makeMockPi(overrides)` from shared test-utils | None (unchanged) |

### Session factories (low priority)

| Test file | Feature | App code duplicated | Curr. level | Curr. mocks | Proposed level | Fix | Proposed mocks |
|---|---|---|---|---|---|---|---|
| `pit/tests/picker-integration.test.ts` | Picker session list | `writeSessionFixture()` — writes hand-crafted JSONL | Integration | None (real fs) | Integration | Import `writeSessionFile(cwd, opts)` from helpers | None (unchanged) |
| `pit/tests/linked-worktree-session.test.ts` | Linked worktree session file | Inline `mkdir` + `writeFile` for session JSONL | Integration | None (real fs) | Integration | Same as above | None (unchanged) |

## What NOT to touch

- **`pit/debug/bwrap-optional-mount-probe.test.ts`** — Tests bwrap `--bind-try`
  behavior, not pit sandbox. Intentionally minimal.
- **Backward-compat test fixtures** (`resume.test.ts` old-format sessions,
  `worktree-carryover` scenarios) — these need specific broken/old schemas
  and should not be generalised.
- **Escape mock server handlers** — each test's handler is domain-specific.
  The server *infrastructure* could be shared but the setup pattern is
  already well-understood. Deferred to separate task.
