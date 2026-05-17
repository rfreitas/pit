/**
 * pit merged-status — footer indicator: is the worktree branch merged to master/main?
 *
 * Shows "✓ merged → <parent>" in the footer once the branch has been merged.
 * Checks on session_start and re-checks every 60 s so an external merge is
 * picked up without restarting the session.
 *
 * Only active when PIT_ESCAPE_SOCKET is set (running under pit with a worktree session).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as net from "node:net";

type IsMergedResponse =
  | { merged: boolean; branch: string | null; parentBranch: string | null }
  | { error: string };

function send(socketPath: string, req: object): Promise<IsMergedResponse> {
  return new Promise((resolve) => {
    const sock = net.createConnection(socketPath);
    let buf = "";
    sock.once("connect", () => { sock.write(JSON.stringify(req) + "\n"); });
    sock.on("data", (chunk: Buffer) => { buf += chunk.toString("utf8"); });
    sock.once("end", () => {
      try { resolve(JSON.parse(buf.trim()) as IsMergedResponse); }
      catch { resolve({ error: "Failed to parse pit-escape response" }); }
    });
    sock.once("error", (err: Error) => {
      resolve({ error: `pit-escape unavailable: ${err.message}` });
    });
  });
}

const STATUS_KEY = "pit-merged";
const POLL_INTERVAL_MS = 60_000; // re-check every minute

export default function (pi: ExtensionAPI) {
  const socketPath = process.env.PIT_ESCAPE_SOCKET;
  if (!socketPath) return;

  let timer: ReturnType<typeof setInterval> | undefined;

  async function updateStatus(setStatus: (text: string | undefined) => void): Promise<void> {
    const resp = await send(socketPath!, { op: "is-merged" });
    if ("error" in resp) return; // silent — socket transient errors are not worth surfacing
    setStatus(resp.merged && resp.parentBranch ? `✓ merged → ${resp.parentBranch}` : undefined);
  }

  pi.on("session_start", async (_event, ctx) => {
    const setStatus = (text: string | undefined) => ctx.ui.setStatus(STATUS_KEY, text);
    await updateStatus(setStatus);
    timer = setInterval(() => void updateStatus(setStatus), POLL_INTERVAL_MS);
  });

  pi.on("session_shutdown", async () => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  });
}
