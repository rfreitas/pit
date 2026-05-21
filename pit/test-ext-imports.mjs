/**
 * Simulates how pi loads extensions: CJS require() of a .ts file
 * via --experimental-strip-types.
 *
 * Run from outside the sandbox:
 *   node pit/test-ext-imports.mjs
 */
import { createRequire } from "node:module";
import { writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";

const cases = [
  { label: 'effect barrel',                   src: `import { Effect } from "effect"; console.log("ok");` },
  { label: 'effect/Effect sub-path',          src: `import { Effect } from "effect/Effect"; console.log("ok");` },
  { label: '@effect/platform barrel',         src: `import { FileSystem } from "@effect/platform"; console.log("ok");` },
  { label: '@effect/platform/FileSystem',     src: `import { FileSystem } from "@effect/platform/FileSystem"; console.log("ok");` },
  { label: '@effect/platform-node barrel',    src: `import { NodeContext } from "@effect/platform-node"; console.log("ok");` },
  { label: '@effect/platform-node/NodeContext', src: `import { layer } from "@effect/platform-node/NodeContext"; console.log("ok");` },
];

for (const { label, src } of cases) {
  const tmp = `/tmp/pit-ext-test-${Date.now()}.ts`;
  writeFileSync(tmp, src);
  const r = spawnSync(process.execPath, ["--experimental-strip-types", tmp], {
    encoding: "utf8", timeout: 5000
  });
  const ok = r.status === 0;
  const err = r.stderr?.match(/Cannot find (?:module|package) '([^']+)'/)?.[1] ?? r.stderr?.slice(0, 60) ?? "";
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : ` — ${err}`}`);
  try { unlinkSync(tmp); } catch {}
}
