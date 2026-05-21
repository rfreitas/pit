/**
 * Tests that all import styles used in pit resolve correctly when loaded
 * with node --experimental-strip-types (same mechanism pi uses for extensions).
 *
 * Run after npm install: node pit/test-ext-imports.mjs
 */
import { writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));

const cases = [
  // Sub-path namespace imports (correct form — sub-path exports raw functions,
  // not a namespace, so import * is required)
  { label: 'import * as Effect from "effect/Effect"',
    src: `import * as Effect from "effect/Effect"; console.log(typeof Effect.gen);` },
  { label: 'import * as Option from "effect/Option"',
    src: `import * as Option from "effect/Option"; console.log(typeof Option.some);` },
  { label: 'import * as Data from "effect/Data"',
    src: `import * as Data from "effect/Data"; console.log(typeof Data.TaggedError);` },

  // @effect/platform sub-paths (named imports)
  { label: 'import { FileSystem } from "@effect/platform/FileSystem"',
    src: `import { FileSystem } from "@effect/platform/FileSystem"; console.log(typeof FileSystem);` },
  { label: 'import { CommandExecutor } from "@effect/platform/CommandExecutor"',
    src: `import { CommandExecutor } from "@effect/platform/CommandExecutor"; console.log(typeof CommandExecutor);` },
  { label: 'import { make } from "@effect/platform/Command"',
    src: `import { make } from "@effect/platform/Command"; console.log(typeof make);` },

  // @effect/platform-node sub-path
  { label: 'import { layer } from "@effect/platform-node/NodeContext"',
    src: `import { layer } from "@effect/platform-node/NodeContext"; console.log(typeof layer);` },

  // Barrel imports that should be flagged by no-barrel-import lint rule
  { label: 'import { Effect } from "effect"  [BARREL — should fail lint]',
    src: `import { Effect } from "effect"; console.log(typeof Effect.gen);` },
  { label: 'import { FileSystem } from "@effect/platform"  [BARREL — should fail lint]',
    src: `import { FileSystem } from "@effect/platform"; console.log(typeof FileSystem);` },
];

for (const { label, src } of cases) {
  const tmp = `${dir}/_test_import_${Date.now()}.ts`;
  writeFileSync(tmp, src);
  const r = spawnSync(process.execPath, ["--experimental-strip-types", tmp], {
    encoding: "utf8", timeout: 5000,
  });
  const ok = r.status === 0;
  const err = r.stderr?.match(/(?:Cannot find (?:module|package)|does not provide an export named) '([^']+)'/)?.[0]
    ?? r.stderr?.trim().split("\n")[0] ?? "";
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : `\n    ${err}`}`);
  try { unlinkSync(tmp); } catch {}
}
