import { Effect } from "effect";
import { NodeContext } from "@effect/platform-node";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { renameBranchEffect } from "./effect.ts";

export const createRenameBranchCommand = (
  socketPath: string,
  token: string,
): ExtensionFactory => (pi: ExtensionAPI) => {
  pi.registerCommand("rename-branch", {
    description: "Rename the worktree branch based on what was built (git diff) or the session topic",
    handler: async (_args, ctx) => {
      await Effect.runPromise(
        renameBranchEffect(ctx, socketPath, token).pipe(
          Effect.catchAll((e) =>
            Effect.sync(() => ctx.ui.notify(e.message, "error")),
          ),
          Effect.provide(NodeContext.layer),
        ),
      );
    },
  });
};
