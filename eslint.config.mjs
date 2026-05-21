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
      // `import * as X` from a sub-path is the correct pattern for namespace
      // APIs (Effect, Option, Stream) where named imports would require verbose
      // renaming and lose the documented call style.
      "local/no-barrel-import": "error",
    },
  },
];
