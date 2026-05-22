/**
 * /rename-branch — command boundary.
 *
 * Registers the command and owns the single error handler that converts
 * propagated errors into user-visible notifications.
 * All business logic lives in effect.ts.
 */

import { Effect } from "effect";
import { NodeContext } from "@effect/platform-node";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renameBranchEffect } from "./effect.ts";

export default function (pi: ExtensionAPI) {
  const socketPath = process.env.PIT_ESCAPE_SOCKET;
  if (!socketPath) return;

  pi.registerCommand("rename-branch", {
    description:
      "Rename the worktree branch based on what was built (git diff) or the session topic",
    handler: async (_args, ctx) => {
      await Effect.runPromise(
        renameBranchEffect(ctx, socketPath).pipe(
          Effect.catchAll((e) =>
            Effect.sync(() => ctx.ui.notify(e.message, "error")),
          ),
          Effect.provide(NodeContext.layer),
        ),
      );
    },
  });
}
