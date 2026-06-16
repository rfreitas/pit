# ollama-loader-ejector package

Source for the `ollama-loader-ejector` Pi extension.

## Structure

- `src/ollama-loader-ejector.ts` — the extension source (edit this)
- `tests/ollama-loader-ejector.test.ts` — tests

## After making changes

Run tests, then install to the extensions folder:

```bash
npm test
npm run install:ext
```

`extensions/ollama-loader-ejector.ts` is git-ignored — it is always a copy of `src/ollama-loader-ejector.ts`.
