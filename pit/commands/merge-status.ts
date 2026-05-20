/**
 * pit merged-status — footer indicator: is the worktree branch merged to master/main?
 *
 * Shows "✓ merged → <parent>" in the footer once the branch has been merged.
 *
 * Uses the pit-escape subscribe op to watch the parent branch ref via fs.watch
 * on the host side — no polling. The 5-minute interval is a safety net only
 * (e.g. if the subscription socket drops).
 *
 * Only active when PIT_ESCAPE_SOCKET is set (running under pit with a worktree session).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as net from "node:net";

type IsMergedResponse =
  | { merged: boolean; branch: string | null; parentBranch: string | null; aheadCount: number; behindCount: number }
  | { error: string };

type SubscribeMessage =
  | { ok: true; watching: string }
  | { event: "ref-change" }
  | { error: string };

function sendOnce(socketPath: string, req: object): Promise<IsMergedResponse> {
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
const FALLBACK_POLL_MS = 5 * 60_000; // 5-minute safety net if subscription drops

export default function (pi: ExtensionAPI) {
  const socketPath = process.env.PIT_ESCAPE_SOCKET;
  if (!socketPath) return;

  let fallbackTimer: ReturnType<typeof setInterval> | undefined;
  let subSocket: net.Socket | undefined;

  async function updateStatus(setStatus: (text: string | undefined) => void): Promise<void> {
    const resp = await sendOnce(socketPath!, { op: "is-merged" });
    if ("error" in resp) return;
    if (!resp.parentBranch) return;
    const { aheadCount, behindCount, parentBranch } = resp;
    if (aheadCount === 0 && behindCount === 0) {
      setStatus(`in sync with ${parentBranch}`);
    } else if (aheadCount > 0 && behindCount === 0) {
      const noun = aheadCount === 1 ? "commit" : "commits";
      setStatus(`${aheadCount} ${noun} ahead of ${parentBranch}`);
    } else if (aheadCount === 0 && behindCount > 0) {
      const noun = behindCount === 1 ? "commit" : "commits";
      setStatus(`${behindCount} ${noun} behind ${parentBranch}`);
    } else {
      setStatus(`${aheadCount} ahead · ${behindCount} behind ${parentBranch}`);
    }
  }

  function openSubscription(setStatus: (text: string | undefined) => void): void {
    const sock = net.createConnection(socketPath!);
    subSocket = sock;
    let buf = "";

    sock.once("connect", () => sock.write(JSON.stringify({ op: "subscribe" }) + "\n"));
    sock.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: SubscribeMessage;
        try { msg = JSON.parse(line) as SubscribeMessage; } catch { continue; }
        if ("event" in msg && msg.event === "ref-change") {
          void updateStatus(setStatus);
        }
        // ok/error acks are informational only; errors mean the subscription
        // couldn't be established — fall back to the poll timer
      }
    });
    sock.once("error", () => { subSocket = undefined; });
    sock.once("close", () => { subSocket = undefined; });
  }

  pi.on("session_start", async (_event, ctx) => {
    const setStatus = (text: string | undefined) => ctx.ui.setStatus(STATUS_KEY, text);

    await updateStatus(setStatus);
    openSubscription(setStatus);

    // Safety-net poll in case the subscription socket ever drops
    fallbackTimer = setInterval(() => void updateStatus(setStatus), FALLBACK_POLL_MS);
  });

  pi.on("session_shutdown", async () => {
    if (fallbackTimer !== undefined) { clearInterval(fallbackTimer); fallbackTimer = undefined; }
    if (subSocket) { subSocket.destroy(); subSocket = undefined; }
  });
}
