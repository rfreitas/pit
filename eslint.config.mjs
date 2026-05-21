// @ts-check
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import importX from "eslint-plugin-import-x";

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
    },
    rules: {
      // ── no barrel imports ─────────────────────────────────────────────────
      //
      // Some packages publish a barrel index that loads their entire module
      // graph regardless of what you actually use. There is no runtime
      // tree-shaking in Node.js — every require() call is synchronous and
      // eager. Use the specific sub-path instead.
      //
      // To add a new entry: measure with
      //   node -e "const b=Object.keys(require.cache).length; require('pkg');
      //            console.log(Object.keys(require.cache).length - b, 'modules')"
      //
      "no-restricted-imports": [
        "error",
        {
          paths: [
            // ~825 modules, ~370ms. Sub-paths load ~522 modules, ~170ms.
            // fast-check (223 files) and undici (110 files) pulled in via
            // Schema.js → FastCheck.js, neither used by pit at runtime.
            {
              name: "@effect/platform",
              message:
                "Use a sub-path: \"@effect/platform/FileSystem\", " +
                "\"@effect/platform/Command\", \"@effect/platform/CommandExecutor\", etc.",
            },
            // same graph as @effect/platform (shares the transitive deps)
            {
              name: "@effect/platform-node",
              message:
                "Use a sub-path: \"@effect/platform-node/NodeContext\", " +
                "\"@effect/platform-node/NodeFileSystem\", etc.",
            },
          ],
        },
      ],

      // ── no namespace imports ──────────────────────────────────────────────
      //
      // `import * as X` hides which members are used. Named imports make the
      // dependency surface explicit. Applies to all modules.
      //
      //   ✗  import * as fs   from "node:fs"
      //   ✓  import { existsSync, readFileSync } from "node:fs"
      //
      // Off-the-shelf rule from eslint-plugin-import-x.
      //
      "import-x/no-namespace": "error",
    },
  },
];
