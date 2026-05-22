/**
 * no-side-effects-in-pure-fn
 *
 * In an Effect-based codebase, functions that interact with the world return
 * Effect<...>, Promise<...>, Stream<...>, or void. A function returning a
 * plain value has declared it is pure — and should be held to that.
 *
 * This rule uses the TypeScript type-checker to identify functions whose
 * return type is a plain value, then flags side-effectful constructs inside
 * them:
 *
 *   - await expressions     (async IO belongs in Effect)
 *   - yield expressions     (generator/Effect context)
 *   - console.* calls       (display logic)
 *   - for/while/do loops    (use .map / .reduce / .filter instead)
 *
 * Purity is checked on the immediately-enclosing function only. A pure
 * function containing an impure nested function is fine — the nested
 * function is checked on its own terms.
 *
 * Replaces the file-scoped functional/no-loop-statements rule on pure.ts,
 * which is now a strict subset of this rule.
 */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { ESLintUtils } = require("@typescript-eslint/utils");

// ── return-type classifier ────────────────────────────────────────────────────

/**
 * Patterns whose presence in a type string marks the function as effectful.
 * Checked against the full TypeScript type string (e.g. "Effect.Effect<...>").
 */
const IMPURE_TYPE_PATTERNS = [
  /\bEffect\b/,   // Effect.Effect<A, E, R>
  /\bPromise\b/,  // Promise<T>
  /\bGenerator\b/, // Generator (Effect.gen internals)
  /^void$/,        // no meaningful return — exists for side effects
  /^undefined$/,   // same
  /^never$/,       // unreachable
];

/**
 * Return true if typeStr represents a plain (non-effectful) value.
 * "string | undefined" is plain; "Effect.Effect<string>" is not.
 */
const isPlainReturnType = (typeStr) => {
  if (!typeStr) return false;
  return !IMPURE_TYPE_PATTERNS.some((p) => p.test(typeStr));
};

// ── rule ──────────────────────────────────────────────────────────────────────

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow side-effectful constructs inside functions whose return type " +
        "is a plain value (not Effect / Promise / Stream / void).",
    },
    messages: {
      noAwait:
        "await in a plain-return function — lift async operations into Effect.promise / Effect.tryPromise.",
      noYield:
        "yield in a plain-return function — plain functions cannot drive Effects.",
      noConsole:
        "console.* in a plain-return function — pure functions have no side effects.",
      noLoop:
        "Loop in a plain-return function — use .map / .filter / .reduce instead.",
    },
    schema: [],
    requiresTypeChecking: true,
  },

  create(context) {
    // ESLintUtils.getParserServices is the @typescript-eslint/utils v8 API.
    // Returns null-like if the parser didn't provide services (e.g. no project config).
    // eslint-disable-next-line functional/no-let -- must be let: getParserServices throws on missing project; catch converts to null
    let parserServices;
    try { parserServices = ESLintUtils.getParserServices(context, false); }
    catch { return {}; }
    if (!parserServices?.program) return {};

    const checker = parserServices.program.getTypeChecker();

    /**
     * Get the return type string for a function node, or null on failure.
     * Works for FunctionDeclaration, ArrowFunctionExpression, FunctionExpression.
     */
    const returnTypeString = (node) => {
      const tsNode = parserServices.esTreeNodeToTSNodeMap?.get(node);
      if (!tsNode) return null;
      try {
        const type = checker.getTypeAtLocation(tsNode);
        const sigs = type.getCallSignatures();
        if (!sigs.length) return null;
        return checker.typeToString(checker.getReturnTypeOfSignature(sigs[0]));
      } catch {
        return null;
      }
    };

    // Stack of booleans — one entry per enclosing function context.
    // True means the immediately-enclosing function returns a plain value.
    // eslint-disable-next-line functional/no-let -- mutable stack required for function-context tracking; no pure alternative for push/pop
    let pureStack = [];

    const enterFn = (node) => {
      // eslint-disable-next-line functional/immutable-data -- stack mutation is the intended operation
      pureStack = [...pureStack, isPlainReturnType(returnTypeString(node))];
    };

    const exitFn = () => {
      // eslint-disable-next-line functional/immutable-data -- stack mutation is the intended operation
      pureStack = pureStack.slice(0, -1);
    };

    /** True if the immediately-enclosing function is plain-return. */
    const inPure = () =>
      pureStack.length > 0 && pureStack[pureStack.length - 1] === true;

    return {
      FunctionDeclaration: enterFn,
      "FunctionDeclaration:exit": exitFn,
      ArrowFunctionExpression: enterFn,
      "ArrowFunctionExpression:exit": exitFn,
      FunctionExpression: enterFn,
      "FunctionExpression:exit": exitFn,

      AwaitExpression(node) {
        if (inPure()) context.report({ node, messageId: "noAwait" });
      },

      YieldExpression(node) {
        if (inPure()) context.report({ node, messageId: "noYield" });
      },

      "CallExpression[callee.object.name='console']"(node) {
        if (inPure()) context.report({ node, messageId: "noConsole" });
      },

      ForStatement(node) {
        if (inPure()) context.report({ node, messageId: "noLoop" });
      },
      WhileStatement(node) {
        if (inPure()) context.report({ node, messageId: "noLoop" });
      },
      DoWhileStatement(node) {
        if (inPure()) context.report({ node, messageId: "noLoop" });
      },
      ForInStatement(node) {
        if (inPure()) context.report({ node, messageId: "noLoop" });
      },
      ForOfStatement(node) {
        if (inPure()) context.report({ node, messageId: "noLoop" });
      },
    };
  },
};
