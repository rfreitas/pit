# Plan: test app-code duplication audit

**Status: planned.** Per-test inventory in [test-audit-inventory.md](test-audit-inventory.md) — 413 rows, one per `it()` block, with status, duration, and file-level duplication flag.

## Problem

Tests should import app code, not reimplement it. When a test copy-pastes app
logic, the test can pass while production silently breaks — the stale copy
masks the regression.

Two root causes:
1. **App code has a side effect tests can't run** (e.g. `process.exit()`).
   Tests copy-paste the pure part — and the copy diverges over time.
2. **Test is at the wrong layer.** A unit test that copy-pastes bwrap arg
   arrays is testing a copy, not the code. It should be an integration test
   that exercises the real function.

## Detection heuristic

To decide if a test-local function is duplicated app code, scan for:

- **Same function name** as an export from an imported production module
- **Same CLI flag strings** (`--tmpfs`, `--ro-bind`, `git worktree add`, etc.)
  that appear verbatim in production code
- **Same file-path literals** (`/nix`, `/mnt/wsl`, `~/.pi/agent`) that
  production mount/config logic constructs
- **Same JSON field shapes** (session entry schemas, pit metadata objects)
  that production serialises

If the test's version would keep passing after the app's version changed,
it's duplicated.

## Process

### Phase 1: baseline

```bash
cd <project>
npx vitest run --reporter=verbose 2>&1 | tee test-baseline.log
```

Record pass/fail/skip/todo per file. This is the ground truth — any fix that
introduces a new failure is a regression.

### Phase 2: inventory (one row per test)

For every `it()` block in the baseline, fill one row in `plans/test-audit-inventory.md`.
Group rows by file. For each test, capture:

- Full name (`describe > inner describe > it`)
- Status (passed / failed / skipped / todo)
- Duration in milliseconds
- File-level duplication flag — does the file that contains this test define
  local helpers that duplicate app code? (yes + what / no)

Build this table by running:
```bash
npx vitest run pit/ --reporter=json 2>/dev/null | python3 <script>
```

The script extracts `assertionResults` per file, joins with a lookup table of
file-level duplication judgments, and writes markdown rows.

### Phase 3: mark duplicated files

Open each file flagged `yes` in the inventory. Read its local helpers.
Compare against production imports using the detection heuristic. Confirm or
refine the duplication judgment. If a helper genuinely doesn't duplicate app
logic, update the flag to `no` with a comment.

### Phase 4: cross-reference

Group files flagged `yes` by the duplicated function name. Count copies.
Sort by count descending — these are the highest-impact fixes.

### Phase 5: proposal (one row per duplication)

For each duplicated function, fill one row:

| Duplicated function | Source module | Files affected | Fix |
|---|---|---|---|
| `buildBwrapArgs` | `launcher.ts` | `sandbox.test.ts`, `resume.test.ts`, ... | Already fixed — import |
| `makeTmpDir` | (no central source) | 9 files listed in inventory | Add `makeTmpSync()` to `helpers.ts`, import in all 9 |
| ... | ... | ... | ... |

Fix options:
- **Extract** — move pure logic from app to its own export, import in tests
- **Import** — test-local copy is identical to an existing shared helper; just import
- **Move up** — unit test at wrong layer, convert to integration test, delete unit test
- **Mock** — replace duplicated setup with `vi.mock`, let the mock provide the value
- **Leave** — intentional (backward compat, probe, old-format fixture)

File: `plans/test-audit-proposals.md`.

### Phase 6: execute

For each proposal row, in priority order (most copies first).

The agent processes one duplicated function at a time. For each:

1. Read the affected test files and the source module
2. Make the change (extract, import, move, or mock)
3. Run ONLY the affected test file: `npx vitest run path/to/file.test.ts`
4. If green, run full suite: `npx vitest run`
5. Commit

Per-file command to keep iteration fast:
```bash
npx vitest run pit/tests/sandbox.test.ts pit/src/resume.test.ts  # only changed files
```

Full suite only after all file-level changes in a batch are green:
```bash
npx vitest run pit/
```

## What NOT to touch

- **Debug probes** — files under `debug/` that test tool behavior, not pit code
- **Backward-compat fixtures** — tests that deliberately use old/broken schemas
  to verify forward compatibility
- **Intentional raw args** — tests that probe bwrap flag semantics (`--bind-try`
  vs `--bind`), not pit's sandbox construction

Tag these with `// Intentional: testing X with old/broken/raw Y`.

## Mocking rules

- Mock at the closest boundary to the unit under test (git utils → mock
  `spawnSync`, not `child_process`)
- Never mock the unit under test itself
- `vi.hoisted` only when the mock must run before the module under test is
  imported (e.g. mocking pi SDK before importing pit code)
