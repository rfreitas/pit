# Pit Extensions

Code in this directory runs **inside Pi** and is loaded via Pi's `jiti` extension loader.

### The Import Trap
Jiti evaluates these files using CJS `require()`. Because of this, **sub-path imports from dual-format packages (like `effect/Effect`) will crash**. Jiti resolves the sub-path to the ESM file, attempts to `require()` it, and throws `Cannot find module`.

**Rule:** Always use barrel imports in this directory.
```ts
// ❌ FAILS (Jiti tries to require an ES module)
import * as Effect from "effect/Effect";

// ✅ WORKS (Jiti successfully requires the CJS main entry)
import { Effect } from "effect";
```

*Note: Core `pit` files (outside this directory) run directly under Node.js ESM. They DO use sub-path imports for a ~200ms startup performance gain. ESLint enforces this boundary.*
