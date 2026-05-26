import { Effect } from "effect";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { mergeEffect } from "./effect.ts";

export const createMergeCommand = (
  socketPath: string,
  token: string,
): ExtensionFactory => (pi: ExtensionAPI) => {
  pi.registerCommand("merge", {
    description: "Merge this worktree branch back to its parent branch (master/main)",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      await Effect.runPromise(
        mergeEffect(ctx, pi, socketPath, token, args.trim()).pipe(
          Effect.catchAll((e) =>
            Effect.sync(() => ctx.ui.notify(`merge: ${String(e)}`, "error")),
          ),
        ),
      );
    },
  });
};
