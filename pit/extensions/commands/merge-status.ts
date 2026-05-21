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

import { Effect } from "effect";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createConnection, type Socket } from "node:net";
import { sendEffect } from "../escape/client.ts";

type IsMergedResponse =
  | {
      merged: boolean;
      branch: string | null;
      parentBranch: string | null;
      aheadCount: number;
      behindCount: number;
    }
  | { error: string };

type SubscribeMessage =
  | { ok: true; watching: string }
  | { event: "ref-change" }
  | { error: string };

const STATUS_KEY = "pit-merged";
const FALLBACK_POLL_MS = 5 * 60_000;

/**
 * Pure function: convert ahead/behind counts into footer text.
 * Exported for testing.
 */
export function formatStatus(
  aheadCount: number,
  behindCount: number,
  parentBranch: string,
): string {
  if (aheadCount === 0 && behindCount === 0) {
    return `in sync with ${parentBranch}`;
  } else if (aheadCount > 0 && behindCount === 0) {
    const noun = aheadCount === 1 ? "commit" : "commits";
    return `${aheadCount} ${noun} ahead of ${parentBranch}`;
  } else if (aheadCount === 0 && behindCount > 0) {
    const noun = behindCount === 1 ? "commit" : "commits";
    return `${behindCount} ${noun} behind ${parentBranch}`;
  } else {
    return `${aheadCount} ahead \u00b7 ${behindCount} behind ${parentBranch}`;
  }
}

export default function (pi: ExtensionAPI) {
  const socketPath = process.env.PIT_ESCAPE_SOCKET;
  if (!socketPath) return;

  // eslint-disable-next-line functional/no-let
  let fallbackTimer: ReturnType<typeof setInterval> | undefined;
  // eslint-disable-next-line functional/no-let
  let subSocket: Socket | undefined;

  const updateStatusEffect = (
    setStatus: (text: string | undefined) => void,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const resp = yield* sendEffect(socketPath!, { op: "is-merged" });
      const r = resp as IsMergedResponse;
      if ("error" in r) return;
      if (!r.parentBranch) return;
      setStatus(formatStatus(r.aheadCount, r.behindCount, r.parentBranch));
    });

  function openSubscription(
    setStatus: (text: string | undefined) => void,
  ): void {
    const sock = createConnection(socketPath!);
    subSocket = sock;
    // eslint-disable-next-line functional/no-let
    let buf = "";

    sock.once("connect", () =>
      sock.write(JSON.stringify({ op: "subscribe" }) + "\n"),
    );
    sock.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      // eslint-disable-next-line functional/no-let
      let nl: number;
      // eslint-disable-next-line functional/no-loop-statements
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const msg = (() => {
          try { return JSON.parse(line) as SubscribeMessage; }
          catch { return null; }
        })();
        if (!msg) continue;
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
