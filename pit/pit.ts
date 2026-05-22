#!/usr/bin/env -S node --experimental-strip-types
/**
 * pit — CLI boundary.
 *
 * Imports the program Effect from core/ and wraps it in typed error handlers.
 * This file owns all console.error and process.exit calls for the CLI.
 * No domain logic lives here.
 */

import * as Effect from "effect/Effect";
import { layer as NodeContextLayer } from "@effect/platform-node/NodeContext";
import { program } from "./program.ts";
import {
  WorktreeCreationError,
  WorktreeMissingError,
  SocketAliveError,
  SessionWriteError,
  SettingsWriteError,
} from "./errors.ts";

type PitError =
  | WorktreeCreationError
  | WorktreeMissingError
  | SocketAliveError
  | SessionWriteError
  | SettingsWriteError;

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
    Effect.provide(NodeContextLayer),
  ),
).catch((err: unknown) => {
  console.error(`pit: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
