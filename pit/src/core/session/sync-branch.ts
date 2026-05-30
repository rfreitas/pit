/**
 * pit sync-branch hook — live session file synchronization.
 *
 * Listens to the pit-escape server for `ref-change` events (which fire
 * when a user runs `git checkout`, `git branch -m`, etc. inside the
 * sandbox). Upon receiving a ref-change, this hook reads the live
 * worktree branch and synchronously updates the `.jsonl` session
 * metadata.
 *
 * This runs as a headless "hook" extension inside the pi process.
 */

import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { refreshPitBranchIfStaleSync } from "./io.ts";
import { isLinkedWorktreeSync, readWorktreeBranchSync } from "../git/utils-sync.ts";

export const createSyncBranchHook = (
  socketPath: string,
  token: string,
): ExtensionFactory => (pi: ExtensionAPI) => {
  let subSocket: import("node:net").Socket | undefined;

  pi.on("session_start", async (_event, ctx) => {
    const cwd = ctx.cwd;

    if (!isLinkedWorktreeSync(cwd) || !socketPath) {
      return;
    }

    try {
      const { createConnection } = await import("node:net");
      subSocket = createConnection(socketPath);
      subSocket.once("connect", () => {
        subSocket!.write(JSON.stringify({ op: "subscribe", token }) + "\n");
      });

      let buffer = "";
      subSocket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        // Maintain the incomplete line in the buffer
        buffer = lines[lines.length - 1] ?? "";
        const completeLines = lines.slice(0, -1);

        for (const line of completeLines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as { event?: string };
            if (msg.event === "ref-change") {
              const freshBranch = readWorktreeBranchSync(cwd);
              const sessionFile = ctx.sessionManager.getSessionFile();
              if (freshBranch && sessionFile) {
                refreshPitBranchIfStaleSync(sessionFile, freshBranch);
              }
            }
          } catch { /* skip corrupt messages */ }
        }
      });
      subSocket.on("error", () => { subSocket = undefined; });
      subSocket.on("close", () => { subSocket = undefined; });
    } catch { /* ignore connection errors */ }
  });

  pi.on("session_shutdown", async () => {
    if (subSocket) {
      subSocket.destroy();
      subSocket = undefined;
    }
  });
};
