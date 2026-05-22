/**
 * Shared client for communicating with the escape server from tools and commands.
 *
 * probeSocket keeps its Promise signature (tested directly).
 * send is Effect-based; commands wrap it with Effect.runPromise where needed.
 */

import { createConnection } from "node:net";
import { existsSync } from "node:fs";
import { Effect, Stream, Option } from "effect";
import { socketLines } from "./frames.ts";

export type GitResult = { stdout: string; stderr: string; code: number };
export type ErrorResult = { error: string };
export type EscapeResult = GitResult | ErrorResult;

// ── socket probe ──────────────────────────────────────────────────────────────

export const probeSocketEffect = (
  socketPath: string,
): Effect.Effect<"alive" | "stale" | "absent"> =>
  Effect.async((resume) => {
    if (!existsSync(socketPath)) {
      resume(Effect.succeed("absent" as const));
      return;
    }
    const sock = createConnection(socketPath);
    sock.once("connect", () => {
      sock.destroy();
      resume(Effect.succeed("alive" as const));
    });
    sock.once("error", (err: NodeJS.ErrnoException) => {
      resume(
        Effect.succeed(
          err.code === "ENOENT" ? ("absent" as const) : ("stale" as const),
        ),
      );
    });
  });

/**
 * Check whether a pit-escape process is actively listening on socketPath.
 *
 *   "alive"  — socket file exists and a process accepted the connection
 *   "stale"  — socket file exists but nobody is listening (ECONNREFUSED/ENOTSOCK)
 *   "absent" — socket file does not exist (ENOENT)
 */
export const probeSocket = (
  socketPath: string,
): Promise<"alive" | "stale" | "absent"> => {
  return Effect.runPromise(probeSocketEffect(socketPath));
};

// ── send ──────────────────────────────────────────────────────────────────────

/**
 * Send a request and read one newline-delimited JSON response.
 * Uses Stream.fromReadableStream + Stream.splitLines — no manual buffer accumulation.
 */
export const sendEffect = (
  socketPath: string,
  req: object,
): Effect.Effect<EscapeResult> =>
  Effect.gen(function* () {
    // Connect
    const sock = yield* Effect.async<ReturnType<typeof createConnection> | null>(
      (resume) => {
        const s = createConnection(socketPath);
        s.once("connect", () => resume(Effect.succeed(s)));
        s.once("error", () => resume(Effect.succeed(null)));
      },
    );
    if (!sock) return { error: "pit-escape unavailable: connection refused" } as EscapeResult;

    // Write request
    sock.write(JSON.stringify(req) + "\n");

    // Read one newline-delimited response — no manual buffer needed
    const line = yield* socketLines(sock).pipe(
      Stream.take(1),
      Stream.runHead,
      Effect.orElse(() => Effect.succeed(Option.none<string>())),
    );

    sock.destroy();

    if (Option.isNone(line))
      return { error: "pit-escape unavailable: no response" } as EscapeResult;
    try { return JSON.parse(line.value) as EscapeResult; }
    catch { return { error: "Failed to parse pit-escape response" } as EscapeResult; }
  });

/** Run sendEffect as a Promise (for use in async extension handlers). */
export const send = (socketPath: string, req: object): Promise<EscapeResult> => {
  return Effect.runPromise(sendEffect(socketPath, req));
};

// ── result helpers ────────────────────────────────────────────────────────────

export const isOk = (r: EscapeResult): r is GitResult => {
  return !("error" in r) && r.code === 0;
};

export const errMsg = (r: EscapeResult): string => {
  if ("error" in r) return r.error;
  return (r.stderr || r.stdout || `exit ${r.code}`).trim();
};
