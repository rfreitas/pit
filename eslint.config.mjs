// @ts-check
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import importX from "eslint-plugin-import-x";
import noBarrelImport from "./eslint-rules/no-barrel-import.mjs";

export default [
  {
    files: ["pit/**/*.ts"],
    ignores: ["pit/tests/**"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.json" },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      "import-x": importX,
      local: { rules: { "no-barrel-import": noBarrelImport } },
    },
    rules: {
      // ── no barrel imports ─────────────────────────────────────────────────
      //
      // Custom rule (eslint-rules/no-barrel-import.mjs).
      // Reads each package's `exports` field at lint time — no hardcoded list.
      // Any package that declares sub-path exports is covered automatically.
      //
      // allow: ["effect"] — the `effect` core barrel IS the intended API.
      // Effect.gen(), Option.some() etc. are documented as barrel imports.
      // The sub-paths (effect/Effect, effect/Option) export raw functions
      // without the namespace, so using them requires `import *` or verbose
      // renaming (effectGen, effectSucceed...) — both worse than the barrel.
      // @effect/platform* are NOT excepted: their sub-paths are idiomatic
      // and correctly structured for named imports.
      //
      "local/no-barrel-import": ["error", { allow: ["effect"] }],

      // ── no namespace imports ──────────────────────────────────────────────
      //
      // `import * as X` hides which members are used. Named imports make the
      // dependency surface explicit. Applies to all modules.
      //
      //   ✗ import * as fs   from "node:fs"
      //   ✓ import { existsSync, readFileSync } from "node:fs"
      //
      // Off-the-shelf rule from eslint-plugin-import-x.
      //
      "import-x/no-namespace": "error",
    },
  },
];
