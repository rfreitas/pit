/**
 * Git tool extension — wraps the pit git helper socket.
 *
 * Only active when PIT_GIT_SOCKET is set (i.e. running under pit with a
 * worktree session). Sends git commands to the out-of-sandbox helper process
 * and returns the output to the LLM.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as net from "node:net";

const ALLOWED = ["add", "commit", "diff", "log", "merge", "rebase", "reset", "show", "stash", "status"];

type HelperResponse = { stdout: string; stderr: string; code: number } | { error: string };

function callHelper(socketPath: string, args: string[], signal: AbortSignal | undefined): Promise<HelperResponse> {
  return new Promise((resolve) => {
    const sock = net.createConnection(socketPath);
    let buf = "";

    const abort = () => sock.destroy();
    signal?.addEventListener("abort", abort, { once: true });

    sock.once("connect", () => { sock.write(JSON.stringify({ args }) + "\n"); });
    sock.on("data", (chunk: Buffer) => { buf += chunk.toString("utf8"); });
    sock.once("end", () => {
      signal?.removeEventListener("abort", abort);
      try { resolve(JSON.parse(buf.trim())); }
      catch { resolve({ error: "Failed to parse git helper response" }); }
    });
    sock.once("error", (err: Error) => {
      signal?.removeEventListener("abort", abort);
      resolve({ error: `Git helper unavailable: ${err.message}` });
    });
  });
}

export default function (pi: ExtensionAPI) {
  const socketPath = process.env.PIT_GIT_SOCKET;
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
      const resp = await callHelper(socketPath!, params.args, signal);
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
