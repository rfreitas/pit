/**
 * no-barrel-import — flag root imports from packages that publish sub-paths.
 *
 * Reads the package's `exports` field at lint time. No hardcoded package list —
 * any package that declares sub-path exports is covered automatically.
 *
 * Caches package.json lookups so each package is resolved once per lint run.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { TSESLint, TSESTree } from "@typescript-eslint/utils";

// ── helpers ───────────────────────────────────────────────────────────────────

/** True if `source` is a root import (not a sub-path, relative, or built-in). */
const isRootImport = (source: string): boolean => {
  if (source.startsWith(".") || source.startsWith("node:")) return false;
  if (source.startsWith("@")) {
    // Scoped: @scope/pkg is root, @scope/pkg/sub is a sub-path
    return source.split("/").length === 2;
  }
  // Unscoped: "pkg" is root, "pkg/sub" is a sub-path
  return !source.includes("/");
};

/**
 * Extract the sub-path keys from an `exports` field.
 * Handles string shorthand, object, and nested conditional forms.
 */
const exportKeys = (exports: unknown): string[] => {
  if (!exports || typeof exports === "string") return [];
  return Object.keys(exports as Record<string, unknown>);
};

/** True if the package at `name` declares sub-path exports. */
const cache = new Map<string, boolean>();

const hasSubPaths = (packageName: string, fromFile: string): boolean => {
  const cached = cache.get(packageName);
  if (cached !== undefined) return cached;

  let result = false;
  try {
    const req = createRequire(join(dirname(fromFile), "__probe__.js"));
    const pkg = req(`${packageName}/package.json`) as { exports?: unknown };
    const keys = exportKeys(pkg.exports);
    result = keys.some((k) => k !== "." && k !== "./package.json");
  } catch {
    // Package not installed, no package.json, or no exports field → allow.
  }

  cache.set(packageName, result);
  return result;
};

// ── rule ──────────────────────────────────────────────────────────────────────

type MessageIds = "useSubPath";
type Options = [{ allow?: string[] }];

const rule: TSESLint.RuleModule<MessageIds, Options> = {
  defaultOptions: [{}],
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow root imports from packages that publish sub-path exports.",
    },
    messages: {
      useSubPath:
        "'{{name}}' publishes sub-path exports — import from a specific " +
        "sub-path to avoid loading the full module graph. " +
        "e.g. '{{name}}/SomeModule' instead of '{{name}}'.",
    },
    schema: [
      {
        type: "object",
        properties: {
          allow: {
            type: "array",
            items: { type: "string" },
            description:
              "Package names to exempt. Use when the barrel IS the intended " +
              "API surface (e.g. 'effect' — its namespace imports are " +
              "idiomatic; sub-paths require `import *` or unusable renaming).",
          },
        },
        additionalProperties: false,
      },
    ],
  },

  create(context) {
    const allow = new Set<string>(context.options[0]?.allow ?? []);
    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration) {
        const source = node.source.value;
        if (allow.has(source)) return;
        if (!isRootImport(source)) return;
        if (!hasSubPaths(source, context.filename)) return;
        context.report({
          node: node.source,
          messageId: "useSubPath",
          data: { name: source },
        });
      },
    };
  },
};

export default rule;
