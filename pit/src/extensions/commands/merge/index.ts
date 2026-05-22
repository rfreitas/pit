/**
 * /merge — command boundary.
 *
 * Registers the command and owns the catchAll that converts unexpected
 * propagated errors into user-visible notifications.
 * All workflow logic lives in effect.ts.
 */

import { Effect } from "effect";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mergeEffect } from "./effect.ts";

export default function (pi: ExtensionAPI) {
  const socketPath = process.env.PIT_ESCAPE_SOCKET;
  if (!socketPath) return;

  pi.registerCommand("merge", {
    description:
      "Merge this worktree branch back to its parent branch (master/main)",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      await Effect.runPromise(
        mergeEffect(ctx, pi, socketPath, args.trim()).pipe(
          Effect.catchAll((e) =>
            Effect.sync(() => ctx.ui.notify(`merge: ${String(e)}`, "error")),
          ),
        ),
      );
    },
  });
}
