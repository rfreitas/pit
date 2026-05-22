/**
 * useEscapeStatus — shared lifecycle for pit-escape footer status items.
 *
 * Wires up the full subscribe + fallback-poll pattern so each status
 * extension only needs to declare its escape op, status key, and format fn.
 *
 * On session_start:
 *   1. Fetches immediately via the named escape op.
 *   2. Opens a persistent subscribe socket; re-fetches on every ref-change.
 *   3. Schedules a fallback poll every FALLBACK_POLL_MS in case the socket drops.
 *
 * On session_shutdown: clears the timer and destroys the subscribe socket.
 *
 * Only registers handlers when PIT_ESCAPE_SOCKET is set.
 */

import { Effect, Stream } from "effect";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createConnection, type Socket } from "node:net";
import { sendEffect } from "./client.ts";
import { socketLines } from "./frames.ts";

const FALLBACK_POLL_MS = 5 * 60_000;

export function useEscapeStatus(
  pi: ExtensionAPI,
  socketPath: string,
  op: string,
  statusKey: string,
  format: (resp: unknown) => string | undefined,
): void {
  let fallbackTimer: ReturnType<typeof setInterval> | undefined;
  let subSocket: Socket | undefined;

  const updateStatusEffect = (
    setStatus: (text: string | undefined) => void,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const resp = yield* sendEffect(socketPath, { op });
      setStatus(format(resp));
    });

  function openSubscription(
    setStatus: (text: string | undefined) => void,
  ): void {
    const sock = createConnection(socketPath);
    subSocket = sock;

    sock.once("connect", () =>
      sock.write(JSON.stringify({ op: "subscribe" }) + "\n"),
    );

    void Effect.runPromise(
      socketLines(sock).pipe(
        Stream.runForEach((line) =>
          Effect.sync(() => {
            const msg = (() => {
              try { return JSON.parse(line) as { event?: string }; }
              catch { return null; }
            })();
            if (msg?.event === "ref-change") {
              void Effect.runPromise(updateStatusEffect(setStatus));
            }
          }),
        ),
      ),
    ).catch(() => { /* socket closed — expected on session end */ });

    sock.once("error", () => { subSocket = undefined; });
    sock.once("close", () => { subSocket = undefined; });
  }

  pi.on("session_start", async (_event, ctx) => {
    const setStatus = (text: string | undefined) =>
      ctx.ui.setStatus(statusKey, text);

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
