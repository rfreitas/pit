/**
 * git tool — runs permitted git subcommands in the worktree.
 */

import { Effect } from "effect";
import type { ExtensionAPI, ExtensionFactory, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { sendEffect } from "../escape/client.ts";

const ALLOWED = ["add", "commit", "diff", "log", "merge", "rebase", "reset", "show", "stash", "status"];

export const createGitTool = (
  socketPath: string,
  token: string,
): ExtensionFactory => (pi: ExtensionAPI) => {
  pi.registerTool({
    name: "git",
    label: "Git",
    description: `Run a git command in the current worktree. Permitted subcommands: ${ALLOWED.join(", ")}.`,
    promptSnippet: "Run git commands (commit, diff, log, status, etc.) in the worktree",
    parameters: Type.Object({
      args: Type.Array(Type.String(), {
        description: 'git arguments, e.g. ["commit", "-m", "fix: update foo"]',
      }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult<undefined>> {
      return Effect.runPromise(
        Effect.gen(function* () {
          const resp = yield* sendEffect(socketPath, token, { op: "git", args: params.args });
          if ("error" in resp) {
            return { content: [{ type: "text" as const, text: resp.error }], isError: true, details: undefined };
          }
          const out = [resp.stdout, resp.stderr].filter(Boolean).join("\n").trim();
          return { content: [{ type: "text" as const, text: out || "(no output)" }], isError: resp.code !== 0, details: undefined };
        }),
      );
    },
  });
};
