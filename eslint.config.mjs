// @ts-check
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import functional from "eslint-plugin-functional";
import noBarrelImport from "./eslint-rules/no-barrel-import.mjs";

// ── Two execution contexts, two sets of rules ─────────────────────────────────
//
// Core files (pit.ts, io modules, server.ts, git/utils.ts):
//   Loaded directly by Node.js with full ESM resolution.
//   MUST use sub-path imports — no barrel imports.
//
// Extension files (commands/, tools/, escape/client.ts, escape/reload.ts):
//   Loaded by pi via jiti (createJiti). Jiti resolves sub-path imports with
//   ["node","import"] conditions first, which finds the ESM file, then tries
//   to require() it — that fails. Barrels work because they go through native
//   import(). Sub-paths from effect-ecosystem packages must be avoided.
//   MUST use barrel imports for @effect/* and effect/* packages.

const base = {
  languageOptions: {
    parser: tsparser,
    parserOptions: { project: "./tsconfig.json" },
  },
  plugins: { 
    "@typescript-eslint": tseslint,
    "functional": functional
  },
};

export default [
  // ── global rules: purity ───────────────────────────────────────────────────
  {
    ...base,
    files: ["pit/**/*.ts"],
    ignores: ["pit/tests/**"],
    rules: {
      // Pushes the codebase towards functional purity.
      // Set to "warn" so it doesn't break CI, but highlights opportunities
      // to extract pure functions and use Effect/Array methods instead of loops.
      "functional/no-let": "warn",               // Use const
      "functional/immutable-data": "warn",       // No Array.push, Object mutation
      "functional/no-loop-statements": "warn",   // Use .map, .reduce, Effect.all
      "prefer-arrow-callback": "warn",           // No function() in callbacks — use arrows
    }
  },

  // ── core files: no barrel imports ──────────────────────────────────────────
  {
    ...base,
    files: ["pit/**/*.ts"],
    ignores: [
      "pit/tests/**",
      "pit/extensions/**",
    ],
    plugins: {
      ...base.plugins,
      local: { rules: { "no-barrel-import": noBarrelImport } },
    },
    rules: {
      // Reads each package's `exports` field at lint time.
      // Any package with sub-path exports must be imported via sub-path.
      "local/no-barrel-import": "error",
    },
  },

  // ── extension files: no sub-path imports for effect ecosystem ──────────────
  {
    ...base,
    files: ["pit/extensions/**/*.ts"],
    rules: {
      // Jiti resolves sub-path imports (e.g. effect/Effect, @effect/platform/FileSystem)
      // using ["node","import"] conditions, which finds the ESM file, then tries
      // to require() it — failing with "Cannot find module".
      // Barrel imports work because jiti uses native import() for the resolved ESM index.
      //
      //   ✗ import * as Effect from "effect/Effect"
      //   ✗ import { FileSystem } from "@effect/platform/FileSystem"
      //   ✓ import { Effect } from "effect"
      //   ✓ import { NodeContext } from "@effect/platform-node"
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["effect/*", "@effect/*/*"],
              message:
                "Extension files are loaded by jiti which fails on sub-path " +
                "imports (resolves to ESM file then tries require()). " +
                "Use barrel imports: \"effect\", \"@effect/platform\", \"@effect/platform-node\".",
            },
          ],
        },
      ],
    },
  },
];
