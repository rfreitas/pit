// @ts-check
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
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
      local: { rules: { "no-barrel-import": noBarrelImport } },
    },
    rules: {
      // Reads each package's `exports` field at lint time — no hardcoded list.
      // Any package that declares sub-path exports is caught automatically.
      //
      // `effect` sub-paths export raw functions without a namespace wrapper,
      // so `import * as Effect from "effect/Effect"` is the correct form.
      // No exception needed — the barrel "effect" is flagged correctly.
      "local/no-barrel-import": "error",
    },
  },
];
