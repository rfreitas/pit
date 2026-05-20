# Plan: pit non-interactive mode fixes and E2E test suite

---

## Fixes

### Fix 1 — stdout pollution (`pit.ts` line 537)

`console.log` → `console.error`. Diagnostics belong on stderr. This is the only pit line that writes to stdout; everything else already uses `console.error`/`console.warn`.

### Fix 2 — `--no-session` implies `noTree` (`worktree/pure.ts` → `parseFlags`)

A session is the only way to reference a worktree from pit. No session means no way to track, resume, or clean up the worktree. Detect `--no-session` in `parseFlags` and set `noTree = true`. The flag still forwards to pi unchanged. The sandbox still runs in the current cwd.

**Unit tests** in `unit.test.ts`:
- `--no-session` → `noTree: true`
- `--no-session` stays in `filteredArgv`
- Combined with other flags still `noTree: true`

---

## E2E test suite — `pit/tests/e2e.test.ts`

### Approach

Drive pit non-interactively using `--mode json` (structured stdout with session header) and `-p` (plain text output). Assert on side effects: worktree existence, session files, stdout/stderr content, exit codes.

**Test repos**: each test creates its own isolated git repo via `os.mkdtempSync()` in the system temp dir. Repos are created fresh per test and removed in `afterEach`. This keeps tests parallel-safe with no cross-test pollution. `pit/test-sandbox/` (already git-ignored) remains available for manual debugging repos.

**No LLM cost**: each test gets a temp agent dir with an empty `auth.json` via `PI_CODING_AGENT_DIR`. Pi will fail at the first LLM call, but pit's setup (worktree creation, session pre-seeding, sandbox launch) all completes before that. Tests assert on those side effects and treat the LLM failure as the expected terminal event.

**Sandbox on**: bwrap is part of what we're testing. Tests skip if bwrap is not found (same guard as existing `sandbox.test.ts`).

---

### Tests

| # | What | Mode | Assert |
|---|------|------|--------|
| 1 | Normal launch in git repo creates worktree and branch | `--mode json` | Session header on stdout; worktree dir and branch exist on disk |
| 2 | `-nt` skips worktree, runs in cwd | `--mode json` | No worktree dir created; session cwd matches repo root |
| 3 | `--no-session` skips worktree (Fix 2) | `--mode json` | No worktree dir or branch created |
| 4 | Launch outside git repo runs no-tree | `--mode json` | No worktree dir; session cwd matches temp dir |
| 5 | Launch from inside an existing pit worktree reuses session, no nesting | `--mode json` | No new worktree; session ID matches existing |
| 6 | Session already open (live socket present) exits with error | `--mode json` | Non-zero exit code; error message on stderr |
| 7 | Sandboxed launch produces clean stdout | `--mode json` | Every stdout line parses as valid JSON; stderr is empty |
| 8 | bwrap not found falls back gracefully | `--mode json` | Warning on stderr; stdout still valid JSON |
| 9 | `-p` stdout contains no pit diagnostic lines (Fix 1) | `-p` | stdout contains only the agent response text, no `pit:` prefixed lines |
| 10 | `--no-session` + `-p` skips worktree (Fix 1 + Fix 2 combined) | `-p` | No worktree dir; stdout clean |
