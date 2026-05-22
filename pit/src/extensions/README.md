# pit/src/extensions

Loaded by Pi via jiti. All files here run inside the Pi process.

## Import rule

Jiti resolves sub-path imports to the ESM file then tries to `require()` it — crashing with "Cannot find module". Use barrel imports for `@effect/*` packages.

```ts
// ❌ crashes under jiti
import * as Effect from "effect/Effect";

// ✅ works
import { Effect } from "effect";
```

Core pit files outside this directory run under Node.js ESM and must use sub-path imports. ESLint enforces both sides of this boundary.

## Folder structure

| Folder | Registers | Rule |
|---|---|---|
| `commands/` | `pi.registerCommand` | Each command has `index.ts` (boundary: registration + `catchAll`) and `effect.ts` (logic: propagates errors) |
| `tools/` | `pi.registerTool` | Agent-facing; tightly constrained |
| `status/` | Footer status items via `useEscapeStatus` in `helpers.ts` | — |
| `hooks/` | `pi.on("session_*")` | Session lifecycle only |
| `escape/` | — | Escape server transport client; shared by commands, tools, status, hooks |
