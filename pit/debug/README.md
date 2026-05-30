# pit/debug

Research harness for platform-specific behaviour that can't be verified in the current environment.

## When to use

When implementing a feature that requires empirical feedback from a platform you can't run locally (e.g. macOS sandbox-exec from a Linux session). Write a probe here to close your open questions before touching production code.

## How it works

- Files here are **excluded** from `npm test` (not in the root `vitest.config.ts` include glob)
- They run via a dedicated config: `npx vitest run --config pit/debug/vitest.config.ts --reporter verbose`
- The CI job `debug-sbpl-macos` in `.github/workflows/test.yml` runs them on `macos-14` with `continue-on-error: true` — failures are amber, never blocking

## Creating a probe

1. Add a `pit/debug/my-feature-probe.test.ts` file
2. Use `it.skipIf(condition)(...)` to skip on platforms that can't run the test
3. Push — the CI job picks it up automatically

## Graduating to production

Once the research is complete:
1. Implement the production code
2. Write production tests in `pit/tests/` or `pit/src/**/*.test.ts` that test the actual application code
3. Delete the probe file — the findings live in the implementation and the plan docs

## Prior art

`sbpl-probe.test.ts` was the first probe, used to validate the macOS sandbox-exec SBPL profile before implementing `sbpl.ts`. All findings are documented in `plans/mac-sandbox.md` and captured in the production code.
