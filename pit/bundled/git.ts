/**
 * Git tool + /merge command — wraps the pit git helper socket.
 *
 * Only active when PIT_ESCAPE_SOCKET is set (running under pit with a worktree session).
 *
 * git tool  — lets the agent run permitted git commands mid-task.
 * /merge    — human-initiated command that orchestrates the full merge workflow:
 *               1. If merge in progress with conflicts → notify agent to resolve
 *               2. If worktree behind parent → merge parent in (notify agent on conflicts)
 *               3. Fast-forward parent branch to worktree branch
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as net from "node:net";

const ALLOWED = ["add", "commit", "diff", "log", "merge", "rebase", "reset", "show", "stash", "status"];

type GitResponse    = { stdout: string; stderr: string; code: number };
type ErrorResponse  = { error: string };
type HelperResponse = GitResponse | ErrorResponse;

type StateResponse = {
  branch: string | null;
  mergeInProgress: boolean;
  conflicts: string[];
  parentBranch: string | null;
  behindParent: boolean;
};

function send(socketPath: string, req: object): Promise<HelperResponse> {
  return new Promise((resolve) => {
    const sock = net.createConnection(socketPath);
    let buf = "";
    sock.once("connect", () => { sock.write(JSON.stringify(req) + "\n"); });
    sock.on("data", (chunk: Buffer) => { buf += chunk.toString("utf8"); });
    sock.once("end", () => {
      try { resolve(JSON.parse(buf.trim()) as HelperResponse); }
      catch { resolve({ error: "Failed to parse pit-escape response" }); }
    });
    sock.once("error", (err: Error) => { resolve({ error: `pit-escape unavailable: ${err.message}` }); });
  });
}

function isOk(r: HelperResponse): r is GitResponse { return !("error" in r) && r.code === 0; }
function errMsg(r: HelperResponse): string {
  if ("error" in r) return r.error;
  return (r.stderr || r.stdout || `exit ${r.code}`).trim();
}

export default function (pi: ExtensionAPI) {
  const socketPath = process.env.PIT_ESCAPE_SOCKET;
  if (!socketPath) return;

  // ── git tool ───────────────────────────────────────────────────────────────

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
      const resp = await send(socketPath!, { op: "git", args: params.args });
      signal; // unused but required by signature
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

  // ── /merge command ─────────────────────────────────────────────────────────

  pi.registerCommand("merge", {
    description: "Merge this worktree branch back to its parent branch (master/main)",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();

      // Get current state from helper (one round-trip)
      const stateResp = await send(socketPath!, { op: "get-state" });
      if ("error" in stateResp) {
        ctx.ui.notify(`pit-escape error: ${stateResp.error}`, "error");
        return;
      }
      const state = stateResp as unknown as StateResponse;

      const parentBranch = args.trim() || state.parentBranch;
      if (!parentBranch) {
        ctx.ui.notify("Could not detect parent branch — run `/merge <branch>` to specify", "error");
        return;
      }

      // ── Phase 1: merge already in progress ──────────────────────────────
      if (state.mergeInProgress) {
        if (state.conflicts.length > 0) {
          ctx.ui.notify("Merge conflicts — agent notified", "warning");
          pi.sendUserMessage(
            `There are unresolved merge conflicts:\n\`\`\`\n${state.conflicts.join("\n")}\n\`\`\`\nPlease resolve them, commit the merge, then run \`/merge\` again.`
          );
        } else {
          ctx.ui.notify("Merge in progress but clean — please commit it first", "info");
        }
        return;
      }

      // ── Phase 2: worktree behind parent → merge parent in ───────────────
      if (state.behindParent) {
        ctx.ui.notify(`Merging ${parentBranch} into branch...`, "info");
        const fwd = await send(socketPath!, { op: "git", args: ["merge", parentBranch] });

        if (!isOk(fwd)) {
          // Check for conflicts after failed merge
          const after = await send(socketPath!, { op: "get-state" }) as unknown as StateResponse;
          if (after.mergeInProgress && after.conflicts.length > 0) {
            ctx.ui.notify("Forward merge has conflicts — agent notified", "warning");
            pi.sendUserMessage(
              `Merging \`${parentBranch}\` into your branch created conflicts:\n\`\`\`\n${after.conflicts.join("\n")}\n\`\`\`\nPlease resolve them, commit the merge, then run \`/merge\` again.`
            );
          } else {
            ctx.ui.notify(`Forward merge failed: ${errMsg(fwd)}`, "error");
          }
          return;
        }
        ctx.ui.notify(`Merged ${parentBranch} into branch`, "info");
      }

      // ── Phase 3: fast-forward parent branch to worktree branch ──────────
      ctx.ui.notify(`Merging ${state.branch ?? "branch"} into ${parentBranch}...`, "info");
      const result = await send(socketPath!, { op: "merge-to-parent", parentBranch });

      if (!isOk(result)) {
        ctx.ui.notify(`Failed to merge into ${parentBranch}: ${errMsg(result)}`, "error");
        return;
      }
      ctx.ui.notify(`Merged into ${parentBranch} ✓`, "info");
    },
  });
}
