/**
 * Shared client for communicating with the escape server from tools and commands.
 */

import * as net from "node:net";

export type GitResult    = { stdout: string; stderr: string; code: number };
export type ErrorResult  = { error: string };
export type EscapeResult = GitResult | ErrorResult;

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
