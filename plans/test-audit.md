# Plan: test app-code duplication audit

**Status: planned.** Findings from the pit investigation are in [test-audit-research.md](test-audit-research.md).

## Problem

Tests should import app code, not reimplement it. When a test copy-pastes app
logic, the test can pass while production silently breaks — the stale copy
masks the regression.

For example this could happen for the following reasons:
1. **App code has a side effect tests can't tolerate** (e.g. `process.exit()`).
   Tests copy the pure part and leave the side effect behind — but the copy
   diverges from the app over time.
2. **Test is at the wrong layer.** Unit-testing sandbox arg construction by
   copy-pasting the arg array is a unit test of a copy, not the code. It should
   be an integration test that runs the real function.

## Litmus test

For every helper function or setup block in a test file, ask: **if the app code
changed tomorrow in a way that should break the test, would the test's copy
still pass?**

- If yes → the test is testing its own copy, not the app. Propose to fix it.
- If no → the test is exercising the real code path. Leave it.

## Decision tree

For each occurrence of duplicated app code found in a test:

```
Test duplicates app code
│
├─ App code has a side effect the test can't run?
│  → Extract the pure logic into its own exported function.
│    Tests import that. The imperative shell gets an integration test
│    or stays untested.
│
├─ Test is at the wrong layer?
│  → Move it up. A unit test that copy-pastes bwrap args should be
│    an integration test that spawns real bwrap with buildBwrapArgs().
│    Delete the unit test — it was testing a copy.
│
├─ Test genuinely needs different behavior?
│  (backward compat, probe semantics, old-format fixtures)
│  → Leave it. Add "// Intentional: testing X with old/broken/raw Y"
│    so the next audit can skip it.
│
└─ Test duplicates app code that should be a shared helper?
   → Extract to helpers.ts, parameterize for all call sites,
     import everywhere.
```

## Mocking

Tests shouldn't duplicate app logic just to avoid mocking. The test's scope is
the unit under test — everything else is noise.

- **Mock at the closest boundary to the unit under test.** Testing
  `worktreeCheckEffect`? Mock the git calls, not the filesystem. Testing git
  utils? Mock `spawnSync`, not git.
- **Never mock the unit under test itself.** If the test mocks the function
  it's supposed to verify, the test asserts nothing.
- **`vi.hoisted` only when the mock must run before module import.** Everything
  else can use top-level `vi.mock` after imports.

## Test layer decision guide

| Test currently uses... | And duplicates... | Consider... |
|---|---|---|
| `vi.mock('child_process')` | Hand-rolled spawn args | Real `spawnSync` integration test (the process actually runs) |
| `vi.mock('node:fs')` | File layout logic | Integration test with real tmp dirs |
| No mocks, raw bwrap/git args | An exported function's output | Import the function instead of copy-pasting its result |
| `vi.mock` + hand-rolled request shapes | Protocol/socket logic | Move to an integration test; unit test the command, not the socket |

## Template

When investigating a test file, fill in one row per duplication found:

| Test file | Feature | App code duplicated | Curr. level | Curr. mocks | Proposed level | Fix | Proposed mocks |
|---|---|---|---|---|---|---|---|
| `path/to/test.ts` | What the test verifies | Which app function is reimplemented | unit / integration / e2e | `vi.mock('x')` or None | unit / integration / e2e | Extract, import, move up, or leave | `vi.mock('x')` or None |

Fields:
- **Test file** — path relative to repo root
- **Feature** — what the test verifies (not what it does, what it's *for*)
- **App code duplicated** — which production module's logic is reimplemented
  in the test
- **Curr. level** — unit (mocked deps) / integration (real deps, no app process)
  / e2e (spawns the app)
- **Curr. mocks** — what the test currently mocks (`vi.mock`, `vi.spyOn`, or
  None for real IO)
- **Proposed level** — where the test should live after the fix
- **Fix** — concrete action: "Extract `functionName()` from `module.ts` and
  import", "Move to integration test in `tests/foo.test.ts`",
  "Replace with `vi.mock('module:fs')`", "Leave (backward compat fixture)"
- **Proposed mocks** — what mocks should remain (or be added) after the fix

## Subagent distribution

The audit is distributed across subagents to keep main-thread context lean.
Each subagent gets **one test file** and one row of the template filled in.

### Why per-file, not per-category

Grouping by category (e.g. "all tmp dir helpers") implies prior research has
already clustered the files. Subagents should do the investigation
independently — each one reads one test file, reads the app code it targets,
and fills the template. The main thread aggregates results and spots patterns.

### Per-file subagent prompt

```
Read the test file at <path> and the production module(s) it targets.
For each function or setup block in the test that reimplements app logic
instead of importing it, fill one row of the audit template:

| Test file | Feature | App code duplicated | Curr. level | Curr. mocks | Proposed level | Fix | Proposed mocks |

If no duplication is found, report "No duplication — all app code imported."
If the duplication is intentional (backward compat, probe), mark Fix as
"Leave (intentional: <reason>)".
```

### Aggregation

After all subagents report, the main thread:
1. Groups findings by duplicated app code (multiple test files duplicating
   the same app function → shared helper candidate).
2. Ranks by impact (number of copies, risk of divergence).
3. Produces the proposal table.
4. Delegates fixes per-file to `cavecrew-builder`.

### What subagents should NOT do

- Don't guess at fixes — only report what's duplicated and at what layer.
- Don't edit code. The audit is read-only investigation.
- Don't cross-reference other test files. Each subagent sees only its
  assigned file.
