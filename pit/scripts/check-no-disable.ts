#!/usr/bin/env -S node --experimental-strip-types
/**
 * check-no-disable — fail if any eslint-disable directive exists in pit/src/.
 *
 * pit/src/ is application code; all rules should pass without suppression.
 * Run as part of `npm run lint`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

type Hit = { file: string; line: number; text: string };

const scan = (dir: string): Hit[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return scan(full);
    if (!full.endsWith(".ts")) return [];
    return readFileSync(full, "utf8")
      .split("\n")
      .flatMap((text, i) =>
        text.includes("eslint-disable")
          ? [{ file: full, line: i + 1, text: text.trim() }]
          : [],
      );
  });

const hits = scan(ROOT);

if (hits.length > 0) {
  for (const { file, line, text } of hits) {
    process.stderr.write(`${file}:${line}  ${text}\n`);
  }
  process.stderr.write(
    `\ncheck-no-disable: ${hits.length} eslint-disable directive(s) in pit/src/ — fix the violation instead.\n`,
  );
  process.exit(1);
}
