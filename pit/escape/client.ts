/**
 * Shared client for communicating with the escape server from tools and commands.
 *
 * probeSocket keeps its Promise signature (tested directly).
 * send is Effect-based; commands wrap it with Effect.runPromise where needed.
 */

import { createConnection } from "node:net";
import { existsSync } from "node:fs";
import * as Effect from "effect/Effect";

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
export function probeSocket(
  socketPath: string,
): Promise<"alive" | "stale" | "absent"> {
  return Effect.runPromise(probeSocketEffect(socketPath));
}

// ── send ──────────────────────────────────────────────────────────────────────

export const sendEffect = (
  socketPath: string,
  req: object,
): Effect.Effect<EscapeResult> =>
  Effect.async((resume) => {
    const sock = createConnection(socketPath);
    let buf = "";
    sock.once("connect", () => {
      sock.write(JSON.stringify(req) + "\n");
    });
    sock.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
    });
    sock.once("end", () => {
      try {
        resume(Effect.succeed(JSON.parse(buf.trim()) as EscapeResult));
      } catch {
        resume(
          Effect.succeed({ error: "Failed to parse pit-escape response" }),
        );
      }
    });
    sock.once("error", (err: Error) => {
      resume(
        Effect.succeed({ error: `pit-escape unavailable: ${err.message}` }),
      );
    });
  });

/** Run sendEffect as a Promise (for use in async extension handlers). */
export function send(socketPath: string, req: object): Promise<EscapeResult> {
  return Effect.runPromise(sendEffect(socketPath, req));
}

// ── result helpers ────────────────────────────────────────────────────────────

export function isOk(r: EscapeResult): r is GitResult {
  return !("error" in r) && r.code === 0;
}

export function errMsg(r: EscapeResult): string {
  if ("error" in r) return r.error;
  return (r.stderr || r.stdout || `exit ${r.code}`).trim();
}
