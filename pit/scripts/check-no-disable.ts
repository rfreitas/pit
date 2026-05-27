#!/usr/bin/env -S node --experimental-strip-types
/**
 * check-no-disable — fail if any eslint-disable directive exists in pit/src/.
 *
 * When a violation is found, prints the file/line, the disabled rule, and
 * concrete refactoring guidance so an agent knows how to fix it without
 * reaching for another disable comment.
 *
 * Lint rule changes may be proposed but require user approval before actioning.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

// ── rule → refactoring advice ─────────────────────────────────────────────────

const ADVICE: Record<string, string> = {
  "no-restricted-syntax":
    "console.* in core/: use Effect.logInfo / Effect.logWarning — pitLogger in pit/src/pit.ts controls the output format.\n" +
    "    process.exit in core/: propagate a typed error and let pit/src/pit.ts handle the exit.",

  "functional/no-let":
    "let in a plain-return function signals state in pure code.\n" +
    "    • Use const if the variable is never rebound.\n" +
    "    • Change the return type to Effect / Promise / void to allow mutation.\n" +
    "    • Use Effect.Ref for shared mutable state in Effect context.",

  "functional/immutable-data":
    "Object mutation in application code.\n" +
    "    Isolate it to a dedicated module with a scoped rule exception (see pit/src/env.ts + eslint.config.mjs).",

  "local/no-side-effects-in-pure-fn":
    "Side effect inside a plain-return function.\n" +
    "    • Change the return type to Effect / Promise / void to signal impurity.\n" +
    "    • Replace console.warn with Effect.logWarning (pitLogger renders it).\n" +
    "    • Wrap unavoidable side effects in Effect.sync and return Effect.",

  "local/no-barrel-import":
    "Root import from a package that exports sub-paths.\n" +
    "    In pit/src/extensions/: barrel imports are required (jiti resolves sub-paths to ESM then tries require()).\n" +
    "    Elsewhere in pit/src/: use the specific sub-path instead.",
};

const FALLBACK_ADVICE =
  "No specific guidance for this rule.\n" +
  "    Refactor to remove the violation; if the disable is genuinely necessary,\n" +
  "    propose a scoped lint rule exception for user approval.";

// ── scan ──────────────────────────────────────────────────────────────────────

type Hit = { file: string; line: number; text: string; rule: string | null };

const extractRule = (text: string): string | null => {
  const m = text.match(/eslint-disable(?:-next-line|-line)?\s+([\w/@.-]+)/);
  return m ? m[1] ?? null : null;
};

const scan = (dir: string): Hit[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return scan(full);
    if (!full.endsWith(".ts") || full.endsWith(".test.ts")) return [];
    return readFileSync(full, "utf8")
      .split("\n")
      .flatMap((text, i) =>
        text.includes("eslint-disable")
          ? [{ file: full, line: i + 1, text: text.trim(), rule: extractRule(text) }]
          : [],
      );
  });

// ── report ────────────────────────────────────────────────────────────────────

const hits = scan(ROOT);

if (hits.length === 0) process.exit(0);

process.stderr.write(
  `\ncheck-no-disable: ${hits.length} eslint-disable directive(s) found in pit/src/\n`,
);

for (const { file, line, text, rule } of hits) {
  process.stderr.write(`\n  ${file}:${line}\n`);
  process.stderr.write(`  ${text}\n`);
  process.stderr.write(`\n  How to fix:\n`);
  const advice = (rule ? ADVICE[rule] : null) ?? FALLBACK_ADVICE;
  for (const l of advice.split("\n")) {
    process.stderr.write(`    ${l}\n`);
  }
}

process.stderr.write(
  "\nRefactor the code following the architecture patterns above.\n" +
  "Proposing a lint rule change is acceptable — but requires user approval before actioning.\n",
);

process.exit(1);
