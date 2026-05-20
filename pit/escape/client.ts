/**
 * Shared client for communicating with the escape server from tools and commands.
 */

import * as net from "node:net";
import * as fs from "node:fs";

export type GitResult    = { stdout: string; stderr: string; code: number };
export type ErrorResult  = { error: string };
export type EscapeResult = GitResult | ErrorResult;

/**
 * Check whether a pit-escape process is actively listening on socketPath.
 *
 *   "alive"  — socket file exists and a process accepted the connection
 *   "stale"  — socket file exists but nobody is listening (ECONNREFUSED/ENOTSOCK)
 *   "absent" — socket file does not exist (ENOENT)
 *
 * Used by startPitEscape to decide whether to fail-fast (alive) or respawn (stale/absent).
 */
export function probeSocket(socketPath: string): Promise<"alive" | "stale" | "absent"> {
  return new Promise((resolve) => {
    if (!fs.existsSync(socketPath)) { resolve("absent"); return; }
    const sock = net.createConnection(socketPath);
    sock.once("connect", () => { sock.destroy(); resolve("alive"); });
    sock.once("error", (err: NodeJS.ErrnoException) => {
      resolve(err.code === "ENOENT" ? "absent" : "stale");
    });
  });
}

export function send(socketPath: string, req: object): Promise<EscapeResult> {
  return new Promise((resolve) => {
    const sock = net.createConnection(socketPath);
    let buf = "";
    sock.once("connect", () => { sock.write(JSON.stringify(req) + "\n"); });
    sock.on("data", (chunk: Buffer) => { buf += chunk.toString("utf8"); });
    sock.once("end", () => {
      try { resolve(JSON.parse(buf.trim()) as EscapeResult); }
      catch { resolve({ error: "Failed to parse pit-escape response" }); }
    });
    sock.once("error", (err: Error) => { resolve({ error: `pit-escape unavailable: ${err.message}` }); });
  });
}

export function isOk(r: EscapeResult): r is GitResult {
  return !("error" in r) && r.code === 0;
}

export function errMsg(r: EscapeResult): string {
  if ("error" in r) return r.error;
  return (r.stderr || r.stdout || `exit ${r.code}`).trim();
}
