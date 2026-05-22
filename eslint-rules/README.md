# eslint-rules

Custom ESLint rules for pit. Written in TypeScript, type-checked by `tsc`, loaded via `node --experimental-strip-types` in the lint script.

## `no-barrel-import.ts`

Flags root imports from packages that publish sub-path exports. Reads each package's `exports` field at lint time — no hardcoded list. Applied to core pit files (not extensions, which must use barrels due to jiti).

To exempt a package: `["local/no-barrel-import", "error", { "allow": ["package-name"] }]`

## `no-side-effects-in-pure-fn.ts`

Flags side-effectful constructs inside functions whose return type is a plain value (not `Effect`, `Promise`, `Generator`, `void`, `undefined`, `never`). Uses the TypeScript type-checker via `@typescript-eslint/utils` `getParserServices`.

Flags: `await`, `yield`, `console.*`, `for`/`while`/`do` loops.

The return type is the signal: in an Effect-based codebase, functions that interact with the world declare it via their return type. A plain return type is a declaration of purity.

To disable on a specific line: `// eslint-disable-next-line local/no-side-effects-in-pure-fn -- <reason>`
