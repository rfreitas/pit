// @ts-check
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import functional from "eslint-plugin-functional";
import eslintComments from "@eslint-community/eslint-plugin-eslint-comments";
import noBarrelImport from "./eslint-rules/no-barrel-import.ts";
import noSideEffectsInPureFn from "./eslint-rules/no-side-effects-in-pure-fn.ts";

// ── Two execution contexts, two sets of rules ─────────────────────────────────
//
// Core files (pit/src/**/*.ts, not extensions):
//   Loaded directly by Node.js with full ESM resolution.
//   MUST use sub-path imports — no barrel imports.
//
// Extension files (pit/src/extensions/**):
//   Loaded by pi via jiti (createJiti). Jiti resolves sub-path imports with
//   ["node","import"] conditions first, which finds the ESM file, then tries
//   to require() it — that fails. Barrels work because they go through native
//   import(). Sub-paths from effect-ecosystem packages must be avoided.
//   MUST use barrel imports for @effect/* and effect/* packages.

const localPlugin = {
  rules: {
    "no-barrel-import": noBarrelImport,
    "no-side-effects-in-pure-fn": noSideEffectsInPureFn,
  },
};

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
      "functional/immutable-data": "error",
      "prefer-arrow-callback": "error",
      "func-style": ["error", "expression"],
      "functional/no-throw-statements": ["error", { "allowToRejectPromises": true }],
      "functional/no-class-inheritance": ["error", {
        // Allow Effect's Data.TaggedError pattern — the only way to define
        // typed errors in Effect. Bans all other class inheritance.
        "ignoreCodePattern": "TaggedError"
      }],
      "functional/no-mixed-types": "error",
      "functional/functional-parameters": ["error", { "enforceParameterCount": false }],
      "functional/prefer-immutable-types": ["error", {
        "enforcement": "None",
        "overrides": [{ "specifiers": { "from": "file" }, "options": {
          "ignoreInferredTypes": true,
          "parameters": { "enforcement": "ReadonlyShallow" }
        }}]
      }],
      "functional/type-declaration-immutability": ["error", {
        "rules": [{
          "identifiers": ["^I?Immutable.+"], "immutability": 5, "comparator": 1
        }, {
          "identifiers": ["^I?ReadonlyDeep.+"], "immutability": 4, "comparator": 1
        }, {
          "identifiers": ["^I?Readonly.+"], "immutability": 3, "comparator": 1
        }, {
          "identifiers": ["^I?Mutable.+"], "immutability": 2, "comparator": -1
        }]
      }],
    }
  },

  // ── plain-return functions: no side effects ──────────────────────────────
  //
  // Uses the TypeScript type-checker to identify functions whose return type
  // is a plain value (not Effect / Promise / Generator / void). Those
  // functions are pure by declaration and must not contain:
  //   - await / yield     (async or Effect context)
  //   - console.*         (display logic)
  //   - for/while loops   (use .map/.filter/.reduce)
  //
  // Replaces the file-scoped functional/no-loop-statements rule on pure.ts
  // (that rule is now a strict subset of this one).
  {
    ...base,
    files: ["pit/**/*.ts"],
    ignores: ["pit/tests/**"],
    plugins: {
      ...base.plugins,
      local: { rules: { "no-side-effects-in-pure-fn": noSideEffectsInPureFn } },
      local: localPlugin,
    },
    rules: {
      "local/no-side-effects-in-pure-fn": "error",
    },
  },

  // ── pure functions only: no loops ─────────────────────────────────────────
  //
  // Kept as a belt-and-suspenders fallback for pure.ts files in case
  // parserServices is unavailable (e.g. editor lint without project config).
  // The type-aware rule above is the primary enforcement.
  {
    ...base,
    files: ["pit/**/pure.ts"],
    rules: {
      "functional/no-loop-statements": "error",
    }
  },

  // ── core files: no barrel imports ──────────────────────────────────────────
  {
    ...base,
    files: ["pit/**/*.ts"],
    ignores: [
      "pit/tests/**",
      "pit/src/extensions/**",
    ],
    plugins: {
      ...base.plugins,
      local: localPlugin,
      "@eslint-community/eslint-comments": eslintComments,
    },
    rules: {
      // Reads each package's `exports` field at lint time.
      // Any package with sub-path exports must be imported via sub-path.
      "local/no-barrel-import": "error",

      // ── eslint-disable hygiene ──────────────────────────────────────────────
      // Every disable comment must name the rule AND give a reason.
      // Bare `eslint-disable` (silencing everything) is banned.
      "@eslint-community/eslint-comments/require-description": ["error", { "ignore": [] }],
      "@eslint-community/eslint-comments/no-unlimited-disable": "error",
      "@eslint-community/eslint-comments/no-unused-disable": "error",
    },
  },

  // ── extension files: no sub-path imports for effect ecosystem ──────────────
  {
    ...base,
    files: ["pit/src/extensions/**/*.ts"],
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
  // ── env.ts: process.env mutation ──────────────────────────────────────────
  {
    ...base,
    files: ["pit/src/env.ts"],
    rules: { "functional/immutable-data": "off" },
  },

  // ── domain layers: no display logic ──────────────────────────────────────
  //
  // Any folder named core/ is domain logic — no console.* or process.exit.
  // Covers pit/core/** and pit/escape/core/** with a single glob.
  // Existing violations carry eslint-disable comments explaining why they are
  // pending migration to a boundary.
  {
    ...base,
    files: ["pit/**/core/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.object.name='console']",
          message:
            "core/ is domain logic — console.* belongs at a boundary (pit/src/pit.ts or pit/src/escape/server.ts).",
        },
        {
          selector:
            "CallExpression[callee.object.name='process'][callee.property.name='exit']",
          message:
            "core/ is domain logic — process.exit belongs at a boundary.",
        },
      ],
    },
  },

];
