---
name: pit-dev
description: Developing and testing pit features. Use when modifying pit source, writing pit tests, or verifying pit behaviour around worktrees, sessions, and the sandbox.
---

# pit dev

## How testing works

The E2E suite (`pit/tests/e2e.test.ts`) drives pit as a real subprocess using
`--mode json` and `-p`. Each test creates its own isolated git repo and agent
dir in the system temp dir, so tests run in parallel with no cross-contamination.

**Zero LLM cost**: every test passes an empty `auth.json` via `PI_CODING_AGENT_DIR`.
Pi fails at the first LLM call, but pit's setup (worktree, session, sandbox) completes
before that — the tests assert on those side effects.

**Sandbox on**: bwrap runs normally. Inside a pit session (nested bwrap), sandbox
tests skip automatically if the kernel blocks nested user namespaces.

## Run all tests

```bash
npm test
```

## Run only pit tests (faster)

```bash
cd pit && npx vitest run
```

## Quick manual test — verify a specific pit behaviour

Set up a throw-away repo and agent dir, then invoke pit directly:

```bash
repo=$(mktemp -d) && git -C "$repo" init -b main -q \
  && git -C "$repo" -c user.email=t@t.t -c user.name=t commit --allow-empty -qm init

agentdir=$(mktemp -d) && echo '{}' > "$agentdir/auth.json"

PI_CODING_AGENT_DIR="$agentdir" PI_SKIP_VERSION_CHECK=1 \
  node --experimental-strip-types pit/pit.ts --mode json "hello" 2>/dev/null \
  | head -1 | python3 -m json.tool
```

Expected: first stdout line is the session header JSON with `cwd` pointing to
a `*-wt-<id>` worktree directory.

## Quick manual test — verify --no-session skips worktree

```bash
PI_CODING_AGENT_DIR="$agentdir" PI_SKIP_VERSION_CHECK=1 \
  node --experimental-strip-types pit/pit.ts --no-session --mode json "hello" 2>/dev/null \
  | head -1 | python3 -m json.tool
```

Expected: `cwd` in the session header equals `$repo` (no worktree created).

## Check stdout is clean JSON for --mode json

```bash
PI_CODING_AGENT_DIR="$agentdir" PI_SKIP_VERSION_CHECK=1 \
  node --experimental-strip-types pit/pit.ts --mode json "hello" 2>/dev/null \
  | while read line; do echo "$line" | python3 -c "import sys,json; json.load(sys.stdin)" \
    || echo "NOT JSON: $line"; done
```

Expected: no `NOT JSON:` lines.

## Cleanup after manual tests

```bash
rm -rf "$repo" "$agentdir"
# Remove worktrees created next to repo:
rm -rf "${repo}-wt-"*
```

## Adding a new E2E test

Follow the pattern in `pit/tests/e2e.test.ts`:

1. Call `makeGitRepo(tmpDirs)` and `makeAgentDir(tmpDirs)` for isolation.
2. Call `runPit(args, { cwd, agentDir })` — returns `{ stdout, stderr, status }`.
3. For `--mode json`: parse stdout lines with `parseJsonLines(stdout)`, find
   `type === "session"` header, assert on `header.cwd` and disk state.
4. For `-p`: assert no `pit:` prefixed lines on stdout.
5. Push dirs to `tmpDirs` — `afterEach` cleans them up automatically.

## What belongs on stdout vs stderr

- **stdout**: only pi's output (JSON events for `--mode json`, response text for `-p`)
- **stderr**: all pit diagnostics (`pit: creating worktree`, `pit: bwrap not found`, etc.)

Any `console.log` in pit source is a bug — use `console.error` instead.
Git subprocess output must use `{ stdio: ["ignore", process.stderr, process.stderr] }`.
