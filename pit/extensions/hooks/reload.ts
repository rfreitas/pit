/**
 * pit reload hook — refreshes filtered settings before pi reloads extensions.
 *
 * Only active when PIT_ESCAPE_SOCKET is set (running under pit, sandboxed).
 */

import { Effect } from "effect";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sendEffect } from "../escape/client.ts";

export default function (pi: ExtensionAPI) {
  const socketPath = process.env.PIT_ESCAPE_SOCKET;
  if (!socketPath) return;

  pi.on("session_shutdown", async (event) => {
    if (event.reason !== "reload") return;

    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* sendEffect(socketPath!, { op: "refresh-settings" });
        if ("error" in result) {
          process.stderr.write(
            `pit: settings refresh failed: ${result.error}\n`,
          );
        }
      }),
    );
  });
}
