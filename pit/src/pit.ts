/**
 * pit — CLI boundary.
 *
 * Imports the program Effect from core/ and wraps it in typed error handlers.
 * This file owns all console.error and process.exit calls for the CLI.
 * No domain logic lives here.
 */

// Inner mode: running inside bwrap as the sandboxed pi process.
// Delegates entirely to inner.ts which calls main() with pit's factories.
if (process.env.PIT_IS_INNER === "1") {
  await import("./inner.ts");
  process.exit(0);
}

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { layer as NodeContextLayer } from "./node-context.ts";
import { program } from "./program.ts";
import {
  WorktreeCreationError,
  WorktreeMissingError,
  SocketAliveError,
  SessionWriteError,
} from "./errors.ts";

// ── logger ───────────────────────────────────────────────────────────────────
//
// Plain renderer: writes the message directly to stderr without timestamps or
// fiber IDs. Domain code uses Effect.logInfo / Effect.logWarning; this layer
// controls the output format.

const pitLogger = Logger.make(({ message }) =>
  process.stderr.write(String(message) + "\n"),
);

const appLayer = Layer.merge(
  NodeContextLayer,
  Logger.replace(Logger.defaultLogger, pitLogger),
);

// ── run ───────────────────────────────────────────────────────────────────────

type PitError =
  | WorktreeCreationError
  | WorktreeMissingError
  | SocketAliveError
  | SessionWriteError;

Effect.runPromise(
  program.pipe(
    Effect.catchTag("WorktreeMissingError", (e) =>
      Effect.sync(() => {
        console.error(`pit: branch '${e.branch}' no longer exists — cannot recreate worktree`);
        process.exit(1);
      }),
    ),
    Effect.catchTag("SocketAliveError", (e) =>
      Effect.sync(() => {
        console.error(
          `pit: session ${e.sessionId} is already open in another terminal.\n` +
          `     Exit that session first, or resume a different one.`,
        );
        process.exit(1);
      }),
    ),
    Effect.catchAll((e: PitError) =>
      Effect.sync(() => {
        console.error(`pit: ${e.message}`);
        process.exit(1);
      }),
    ),
    Effect.provide(appLayer),
  ),
).catch((err: unknown) => {
  console.error(`pit: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
