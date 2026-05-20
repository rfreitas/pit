/**
 * git tool — agent-facing, runs permitted git subcommands in the worktree.
 *
 * Only active when PIT_ESCAPE_SOCKET is set (pit worktree session).
 * Subcommand allowlist enforced by pit-escape; the tool passes args through.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { send } from "../escape-client.ts";

const ALLOWED = ["add", "commit", "diff", "log", "merge", "rebase", "reset", "show", "stash", "status"];

export default function (pi: ExtensionAPI) {
  const socketPath = process.env.PIT_ESCAPE_SOCKET;
  if (!socketPath) return;

  pi.registerTool({
    name: "git",
    label: "Git",
    description: `Run a git command in the current worktree. Permitted subcommands: ${ALLOWED.join(", ")}.`,
    promptSnippet: "Run git commands (commit, diff, log, status, etc.) in the worktree",
    parameters: Type.Object({
      args: Type.Array(Type.String(), {
        description: 'git arguments, e.g. ["commit", "-m", "fix: update foo"] or ["status"] or ["log", "--oneline", "-5"]',
      }),
    }),
    async execute(_id, params, signal) {
      signal; // unused but required by signature
      const resp = await send(socketPath!, { op: "git", args: params.args });
      if ("error" in resp) {
        return { content: [{ type: "text" as const, text: resp.error }], isError: true, details: { code: undefined as number | undefined } };
      }
      const out = [resp.stdout, resp.stderr].filter(Boolean).join("\n").trim();
      return {
        content: [{ type: "text" as const, text: out || "(no output)" }],
        isError: resp.code !== 0,
        details: { code: resp.code as number | undefined },
      };
    },
  });
}
