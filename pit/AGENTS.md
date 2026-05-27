# pit Agent Instructions

Read the pit-dev skill before making changes: `.pi/skills/pit-dev/SKILL.md`

## Before touching each area

| Area | Read first |
|---|---|
| `core/` | `pit/src/core/README.md` |
| `escape/` | `pit/src/escape/README.md` |
| `extensions/` | `pit/src/extensions/README.md` |
| `eslint-rules/` | `eslint-rules/README.md` |

## After any change

```bash
npm run typecheck   # must pass
npm run lint        # must pass — zero errors
npm test            # must pass
```

These run automatically on commit via the pre-commit hook in `.githooks/`. If
the hook isn't active yet, enable it once:

```bash
git config core.hooksPath .githooks
```

Or run `npm install` — the `prepare` script sets this up automatically.

## Writing docs

Be concise, factual, and to the point. README.md is authoritative. AGENTS.md points to it — no duplication.

## Debugging platform-specific behaviour

When researching OS-level behaviour that cannot be verified in the current environment (e.g. macOS sandbox-exec from a Linux session), use `pit/debug/`:

- Files in `pit/debug/` are **not** picked up by `npm test` (excluded from the root `vitest.config.ts` include glob)
- They use a dedicated config: `npx vitest run --config pit/debug/vitest.config.ts --reporter verbose`
- The CI job `debug-sbpl-macos` in `.github/workflows/test.yml` runs them with `continue-on-error: true` — failures are amber, never blocking
- Use this pattern when the right answer requires empirical feedback from a platform you can't run locally
- Once the research is complete and the production code is written, graduate the relevant assertions into real production tests in `pit/tests/` that test the actual application code
- Keep `pit/debug/` files clearly labelled as research/probe code, not production tests
