/**
 * pit reload hook — refreshes filtered settings before pi reloads extensions.
 *
 * Only active when PIT_ESCAPE_SOCKET is set (running under pit, sandboxed).
 *
 * When the user runs /reload, pi fires session_shutdown with reason "reload"
 * before tearing down extensions. We await a refresh-settings call to
 * pit-escape here so the host-side settings file is up-to-date before pi
 * re-reads it during the reload cycle. This means globally-installed packages
 * (added outside the session) are picked up correctly, with the denylist
 * still applied.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as net from "node:net";

type EscapeResponse = { ok: true } | { error: string };

function send(socketPath: string, req: object): Promise<EscapeResponse> {
  return new Promise((resolve) => {
    const sock = net.createConnection(socketPath);
    let buf = "";
    sock.once("connect", () => { sock.write(JSON.stringify(req) + "\n"); });
    sock.on("data", (chunk: Buffer) => { buf += chunk.toString("utf8"); });
    sock.once("end", () => {
      try {
        resolve(JSON.parse(buf.trim()) as EscapeResponse);
      } catch {
        resolve({ error: "Failed to parse pit-escape response" });
      }
    });
    sock.once("error", (err: Error) => {
      resolve({ error: `pit-escape unavailable: ${err.message}` });
    });
  });
}

export default function (pi: ExtensionAPI) {
  const socketPath = process.env.PIT_ESCAPE_SOCKET;
  if (!socketPath) return;

  pi.on("session_shutdown", async (event) => {
    if (event.reason !== "reload") return;

    const result = await send(socketPath, { op: "refresh-settings" });
    if ("error" in result) {
      // Non-fatal: reload proceeds with stale settings rather than blocking
      process.stderr.write(`pit: settings refresh failed: ${result.error}\n`);
    }
  });
}
