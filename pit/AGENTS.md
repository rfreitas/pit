# pit Agent Instructions

Read the pit-dev skill before making changes: `.pi/skills/pit-dev/SKILL.md`

## Directory structure

```
pit/
  pit.ts                  ← entry point, runs directly under Node.js ESM
  errors.ts               ← Effect tagged error types
  types.ts                ← shared TypeScript types
  git/                    ← filesystem + subprocess utilities
  sandbox/                ← bwrap mount spec builders
  session/                ← pi session JSONL read/write
  worktree/               ← git worktree creation
  escape/
    server.ts             ← pit-escape subprocess (runs outside sandbox)
  extensions/             ← everything loaded by pi via jiti
    escape/
      client.ts           ← escape protocol client
      reload.ts           ← session_shutdown extension
    commands/             ← pi slash commands (/merge, /rename-branch, etc.)
    tools/                ← pi tools (git)
  dev/                    ← manual diagnostic scripts
```

## Two execution contexts — critical import rules

Files outside `pit/extensions/` run directly under **Node.js ESM**.
Files inside `pit/extensions/` are loaded by pi via **jiti** (CJS require).

| Context | Rule | Enforced by |
|---|---|---|
| Core files (`pit/*.ts`, `pit/*/`) | Sub-path imports required | `local/no-barrel-import` |
| Extension files (`pit/extensions/**`) | Barrel imports required for `@effect/*` | `no-restricted-imports` |

**Why:** Jiti resolves sub-path imports using `["node","import"]` conditions, finds
the ESM file, then tries to `require()` it — crashing with "Cannot find module".
Barrels work because jiti falls through to native `import()` for the resolved ESM index.

See `pit/extensions/README.md` for the full explanation.

## Effect architecture

Core files use Effect throughout. The single edge is at the bottom of `pit.ts`:
```typescript
Effect.runPromise(program.pipe(Effect.provide(NodeContext.layer)))
```

Extension files use plain `async/await` internally; they call `send()` (Promise)
from `escape/client.ts` rather than `sendEffect`.

## After any change

```bash
npm run typecheck   # must pass
npm run lint        # must pass — zero errors; warnings are purity hints
npm test            # 320 tests must pass
```

The e2e tests include `all pit extensions load without errors` which specifically
catches jiti import failures. If extensions break, this test fails first.
