# pit/src/core

Domain logic for the pit launcher. No display logic here.

## Rule

No `console.*` or `process.exit` in this folder. Enforced by `local/no-restricted-syntax`. Existing violations carry `eslint-disable-next-line` comments explaining why they are pending migration to a boundary.

Errors propagate to callers — display happens at `pit.ts` (CLI boundary).

## Contents

| File/folder | Purpose |
|---|---|
| `constants.ts` | `HOME`, `AGENT_DIR`, `PIT_DIR` — resolved once at startup |
| `git/utils.ts` | filesystem + subprocess git utilities |
| `sandbox/pure.ts` | mount spec builder; `formatSandboxNote`; `buildSealedEnv` (pure) |
| `sandbox/sbpl.ts` | macOS SBPL profile builder for sandbox-exec (pure) |
| `sandbox/io.ts` | pit config read, settings filtering |
| `session/pure.ts` | session JSONL content builders (pure) |
| `session/io.ts` | session file read/write |
| `worktree/pure.ts` | `PitMetadata` builders, flag parsing (pure) |
| `worktree/io.ts` | git worktree creation and recreation |
