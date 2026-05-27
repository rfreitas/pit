/**
 * pit reload hook — refreshes filtered settings before pi reloads extensions.
 */

import { Effect } from "effect";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { sendEffect } from "../escape/client.ts";

export const createReloadHook = (
  socketPath: string,
  token: string,
): ExtensionFactory => (pi: ExtensionAPI) => {
  pi.on("session_shutdown", async (event) => {
    if (event.reason !== "reload") return;

    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* sendEffect(socketPath, token, { op: "refresh-settings" });
        if ("error" in result) {
          yield* Effect.logWarning(`pit: settings refresh failed: ${result.error}`);
        }
      }),
    );
  });
};
