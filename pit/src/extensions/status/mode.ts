/**
 * pit mode footer — shows worktree/no-tree mode and sandbox status in the
 * pi status bar on every session start.
 *
 * Examples:
 *   "worktree"  +  "sandbox"
 *   "no-tree"   +  "no sandbox"
 *
 * Mode is derived from live git state (isLinkedWorktree),
 * never from stored session metadata. Uses plain node:fs to avoid jiti/Effect
 * runtime issues in extension context.
 */

import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { isLinkedWorktreeSync } from "../../core/git/utils-sync.ts";

export const createModeStatus = (
  sandbox: boolean,
): ExtensionFactory => (pi: ExtensionAPI) => {
  pi.on("session_start", async (_event, ctx) => {
    const cwd = ctx.cwd;

    if (isLinkedWorktreeSync(cwd)) {
      ctx.ui.setStatus("pit-mode", "worktree");
    } else {
      ctx.ui.setStatus("pit-mode", "no-tree");
    }

    ctx.ui.setStatus("pit-sandbox", sandbox ? "sandbox" : "no sandbox");
  });
};
