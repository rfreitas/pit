/**
 * pit loc-diff — footer indicator: lines changed vs the parent branch.
 *
 * Shows "+42 −7" (or "+42" / "−7" when only one side is non-zero) in the
 * footer, counting committed lines diffed from the merge-base with parent.
 *
 * Reuses the pit-escape subscribe op so updates fire on every commit to
 * either the worktree branch or the parent branch — no extra watchers.
 *
 * Only active when PIT_ESCAPE_SOCKET is set (running under pit with a
 * worktree session).
 */

import { Effect } from "effect";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createConnection, type Socket } from "node:net";
import { sendEffect } from "../escape/client.ts";

type LocDiffResponse =
  | { insertions: number; deletions: number; parentBranch: string | null }
  | { error: string };

type SubscribeMessage =
  | { ok: true; watching: string }
  | { event: "ref-change" }
  | { error: string };

const STATUS_KEY = "pit-loc";
const FALLBACK_POLL_MS = 5 * 60_000;

/**
 * Pure function: convert insertion/deletion counts into footer text.
 * Returns undefined when both are zero (hides the status item).
 * Exported for testing.
 */
export function formatLoc(
  insertions: number,
  deletions: number,
): string | undefined {
  if (insertions === 0 && deletions === 0) return undefined;
  if (insertions > 0 && deletions === 0) return `+${insertions}`;
  if (insertions === 0 && deletions > 0) return `\u2212${deletions}`;
  return `+${insertions} \u2212${deletions}`;
}

export default function (pi: ExtensionAPI) {
  const socketPath = process.env.PIT_ESCAPE_SOCKET;
  if (!socketPath) return;

  let fallbackTimer: ReturnType<typeof setInterval> | undefined;
  let subSocket: Socket | undefined;

  const updateStatusEffect = (
    setStatus: (text: string | undefined) => void,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const resp = yield* sendEffect(socketPath!, { op: "loc-diff" });
      const r = resp as LocDiffResponse;
      if ("error" in r) return;
      setStatus(formatLoc(r.insertions, r.deletions));
    });

  function openSubscription(
    setStatus: (text: string | undefined) => void,
  ): void {
    const sock = createConnection(socketPath!);
    subSocket = sock;
    let buf = "";

    sock.once("connect", () =>
      sock.write(JSON.stringify({ op: "subscribe" }) + "\n"),
    );
    sock.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: SubscribeMessage;
        try {
          msg = JSON.parse(line) as SubscribeMessage;
        } catch {
          continue;
        }
        if ("event" in msg && msg.event === "ref-change") {
          void Effect.runPromise(updateStatusEffect(setStatus));
        }
      }
    });
    sock.once("error", () => {
      subSocket = undefined;
    });
    sock.once("close", () => {
      subSocket = undefined;
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    const setStatus = (text: string | undefined) =>
      ctx.ui.setStatus(STATUS_KEY, text);

    await Effect.runPromise(updateStatusEffect(setStatus));
    openSubscription(setStatus);

    fallbackTimer = setInterval(
      () => void Effect.runPromise(updateStatusEffect(setStatus)),
      FALLBACK_POLL_MS,
    );
  });

  pi.on("session_shutdown", async () => {
    if (fallbackTimer !== undefined) {
      clearInterval(fallbackTimer);
      fallbackTimer = undefined;
    }
    if (subSocket) {
      subSocket.destroy();
      subSocket = undefined;
    }
  });
}
