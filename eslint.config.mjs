// @ts-check
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
  {
    files: ["pit/**/*.ts"],
    ignores: ["pit/tests/**"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.json" },
    },
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      // ── rule 1: no effect platform barrel imports ────────────────────────
      //
      // @effect/platform and @effect/platform-node barrel index files pull in
      // 825 modules including fast-check and undici, adding ~300ms startup
      // overhead per pit subprocess invocation. Sub-path imports load ~522
      // modules in ~170ms.
      //
      //   ✗ import { FileSystem } from "@effect/platform"
      //   ✓ import { FileSystem } from "@effect/platform/FileSystem"
      //
      //   ✗ import { NodeContext } from "@effect/platform-node"
      //   ✓ import { layer } from "@effect/platform-node/NodeContext"
      //
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@effect/platform",
              message:
                'Use a sub-path import instead: "@effect/platform/FileSystem", ' +
                '"@effect/platform/Command", "@effect/platform/CommandExecutor", etc. ' +
                "Barrel imports add ~300ms startup time.",
            },
            {
              name: "@effect/platform-node",
              message:
                'Use a sub-path import instead: "@effect/platform-node/NodeContext", ' +
                '"@effect/platform-node/NodeFileSystem", etc. ' +
                "Barrel imports add ~300ms startup time.",
            },
          ],
        },
      ],

      // ── rule 2: no namespace imports from Node built-ins ─────────────────
      //
      // `import * as fs from "node:fs"` hides which members are used and
      // makes the import surface opaque. Use named imports.
      //
      //   ✗ import * as fs   from "node:fs"
      //   ✗ import * as path from "node:path"
      //   ✗ import * as os   from "node:os"
      //   ✓ import { existsSync, readFileSync } from "node:fs"
      //   ✓ import { join, dirname } from "node:path"
      //
      // Note: `import * as Command from "@effect/platform/Command"` is
      // intentionally exempt — Command is a fluent namespace API where the
      // star import is the idiomatic usage (Command.make, Command.string, ...).
      //
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ImportDeclaration[source.value=/^node:/] > ImportNamespaceSpecifier",
          message:
            "Use named imports from Node built-ins instead of namespace imports. " +
            "e.g. import { existsSync, readFileSync } from 'node:fs'",
        },
      ],
    },
  },
];
