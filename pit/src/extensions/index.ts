/**
 * Factory aggregator — creates all pit-internal extension factories.
 * Called by inner.ts with the escape socket path and auth token.
 */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createGitTool } from "./tools/git.ts";
import { createMergeCommand } from "./commands/merge/index.ts";
import { createRenameBranchCommand } from "./commands/rename-branch/index.ts";
import { createBranchStatus } from "./status/branch-status.ts";
import { createModeStatus } from "./status/mode.ts";

import { createSyncBranchHook } from "../core/session/sync-branch.ts";

export const createExtensionFactories = (
  socketPath: string,
  token: string,
  sandbox: boolean,
): ExtensionFactory[] => {
  return [
    createModeStatus(sandbox),
    ...(socketPath ? [
      createSyncBranchHook(socketPath, token),
      createGitTool(socketPath, token),
      createMergeCommand(socketPath, token),
      createRenameBranchCommand(socketPath, token),
      createBranchStatus(socketPath, token),
    ] : []),
  ];
};
