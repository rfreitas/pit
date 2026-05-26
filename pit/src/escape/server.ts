#!/usr/bin/env -S node --experimental-strip-types
/**
 * pit-escape — socket boundary.
 *
 * Starts the Unix socket server, routes requests to ops/, and owns the single
 * error handler that converts unhandled op failures into JSON error responses.
 * No op logic lives here.
 *
 * Protocol: see ops/ files for request/response shapes per op.
 */

import { createServer } from "node:net";
import type { Socket } from "node:net";
import { unlinkSync } from "node:fs";
import * as Effect from "effect/Effect";
import { layer as NodeContextLayer, type NodeContext } from "@effect/platform-node/NodeContext";
import { gitEffect } from "./core/ops/git.ts";
import { opGetState } from "./core/ops/state.ts";
import { opMergeToParent, opIsMerged } from "./core/ops/merge.ts";
import { opLocDiff } from "./core/ops/diff.ts";
import { opRefreshSettings } from "./core/ops/settings.ts";
import { handleSubscribe } from "./core/ops/subscribe.ts";

const [, , token, socketPath, worktreePath, agentDir, pitDir, hostSettingsPath] =
  process.argv;
if (!token || !socketPath || !worktreePath || !agentDir || !pitDir || !hostSettingsPath) {
  process.stderr.write(
    "usage: pit-escape <token> <socket-path> <worktree-path> <agent-dir> <pit-dir> <host-settings-path>\n",
  );
  process.exit(1);
}

const GIT_ALLOWED = new Set([
  "add", "commit", "diff", "log", "merge",
  "rebase", "reset", "show", "stash", "status",
]);

type Request = {
  op?: string;
  token?: string;
  args?: unknown;
  parentBranch?: string;
  newBranch?: string;
};

const dispatchEffect = (
  req: Readonly<Request>,
): Effect.Effect<{ result: object; keepOpen: boolean }, never, NodeContext> =>
  Effect.gen(function* () {
    switch (req.op) {
      case "git": {
        const args = req.args;
        if (!Array.isArray(args) || args.length === 0 || typeof args[0] !== "string") {
          return { result: { error: "git op requires args (string[])" }, keepOpen: false };
        }
        const [sub, ...rest] = args as string[];
        if (!GIT_ALLOWED.has(sub)) {
          return {
            result: { error: `git ${sub}: not permitted. Allowed: ${[...GIT_ALLOWED].join(", ")}` },
            keepOpen: false,
          };
        }
        return { result: yield* gitEffect([sub, ...rest], worktreePath), keepOpen: false };
      }
      case "get-state":
        return { result: yield* opGetState(worktreePath), keepOpen: false };
      case "merge-to-parent":
        if (!req.parentBranch) {
          return { result: { error: "merge-to-parent requires parentBranch" }, keepOpen: false };
        }
        return { result: yield* opMergeToParent(req.parentBranch, worktreePath), keepOpen: false };
      case "loc-diff":
        return { result: yield* opLocDiff(worktreePath), keepOpen: false };
      case "is-merged":
        return { result: yield* opIsMerged(worktreePath), keepOpen: false };
      case "refresh-settings":
        return { result: yield* opRefreshSettings(agentDir, pitDir, hostSettingsPath), keepOpen: false };
      case "rename-branch": {
        const { newBranch } = req;
        if (!newBranch || typeof newBranch !== "string") {
          return { result: { error: "rename-branch requires newBranch (string)" }, keepOpen: false };
        }
        return { result: yield* gitEffect(["branch", "-m", newBranch], worktreePath), keepOpen: false };
      }
      case "subscribe":
        return { result: {}, keepOpen: true };
      default:
        return { result: { error: `Unknown op: ${req.op}` }, keepOpen: false };
    }
  });

// ── server ────────────────────────────────────────────────────────────────────

const cleanup = () => {
  server.close();
  try { unlinkSync(socketPath); } catch { /* already gone */ }
  process.exit(0);
};
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);

const server = createServer((socket: Socket) => {
  let buf = "";

  socket.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    const nl = buf.indexOf("\n");
    if (nl === -1) return;
    const line = buf.slice(0, nl);
    buf = "";

    const req = (() => {
      try { return JSON.parse(line) as Request; }
      catch {
        socket.end(JSON.stringify({ error: "invalid JSON" }) + "\n");
        return null;
      }
    })();
    if (!req) return;

    if (req.token !== token) {
      socket.end(JSON.stringify({ error: "unauthorized" }) + "\n");
      return;
    }

    if (typeof req.op !== "string") {
      socket.end(JSON.stringify({ error: "request must have op (string)" }) + "\n");
      return;
    }

    if (req.op === "subscribe") {
      handleSubscribe(socket, worktreePath);
      return;
    }

    void Effect.runPromise(
      dispatchEffect(req).pipe(Effect.provide(NodeContextLayer)),
    ).then(({ result, keepOpen }) => {
      if (!keepOpen) socket.end(JSON.stringify(result) + "\n");
    });
  });

  socket.on("error", () => { /* ignore client disconnect errors */ });
});

server.listen(socketPath, () => {
  process.stdout.write("ready\n");
});

server.on("error", (err: Error) => {
  process.stderr.write(`pit-escape: ${err.message}\n`);
  process.exit(1);
});
