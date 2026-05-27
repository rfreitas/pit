/**
 * Factory aggregator — creates all pit-internal extension factories.
 * Called by inner.ts with the escape socket path and auth token.
 */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createReloadHook } from "./hooks/reload.ts";
import { createGitTool } from "./tools/git.ts";
import { createMergeCommand } from "./commands/merge/index.ts";
import { createRenameBranchCommand } from "./commands/rename-branch/index.ts";
import { createBranchStatus } from "./status/branch-status.ts";

export const createExtensionFactories = (
  socketPath: string,
  token: string,
): ExtensionFactory[] => {
  if (!socketPath) return [];
  return [
    createReloadHook(socketPath, token),
    createGitTool(socketPath, token),
    createMergeCommand(socketPath, token),
    createRenameBranchCommand(socketPath, token),
    createBranchStatus(socketPath, token),
  ];
};
