#!/usr/bin/env -S node --experimental-strip-types
/**
 * pit git helper — runs OUTSIDE the bwrap sandbox.
 *
 * Accepts git command requests over a Unix socket, validates them against an
 * allowlist, executes them in the worktree, and streams results back as JSON.
 *
 * Protocol (newline-delimited JSON, one request per connection):
 *   Request:  { "args": ["commit", "-m", "message"] }
 *   Response: { "stdout": "...", "stderr": "...", "code": 0 }
 *          or { "error": "reason" }
 *
 * Signals readiness to the parent by writing "ready\n" to stdout.
 * Cleans up the socket file on SIGTERM/SIGINT.
 */

import * as net from "node:net";
import * as fs from "node:fs";
import { execFile } from "node:child_process";

const [, , socketPath, worktreePath] = process.argv;
if (!socketPath || !worktreePath) {
  process.stderr.write("usage: git-helper <socket-path> <worktree-path>\n");
  process.exit(1);
}

const ALLOWED = new Set([
  "add", "commit", "diff", "log", "merge",
  "rebase", "reset", "show", "stash", "status",
]);

function cleanup() {
  server.close();
  try { fs.unlinkSync(socketPath); } catch { /* already gone */ }
  process.exit(0);
}
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);

const server = net.createServer((socket) => {
  let buf = "";

  socket.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    const nl = buf.indexOf("\n");
    if (nl === -1) return;
    const line = buf.slice(0, nl);
    buf = "";

    let req: { args?: unknown };
    try { req = JSON.parse(line); } catch {
      socket.end(JSON.stringify({ error: "invalid JSON" }) + "\n");
      return;
    }

    if (!Array.isArray(req.args) || req.args.length === 0 || typeof req.args[0] !== "string") {
      socket.end(JSON.stringify({ error: "args must be a non-empty string array" }) + "\n");
      return;
    }

    const [sub, ...rest] = req.args as string[];
    if (!ALLOWED.has(sub)) {
      socket.end(JSON.stringify({ error: `git ${sub}: not permitted. Allowed: ${[...ALLOWED].join(", ")}` }) + "\n");
      return;
    }

    execFile("git", [sub, ...rest], { cwd: worktreePath }, (err, stdout, stderr) => {
      const code = err ? (Number((err as NodeJS.ErrnoException).code) || 1) : 0;
      socket.end(JSON.stringify({ stdout, stderr, code }) + "\n");
    });
  });

  socket.on("error", () => { /* ignore client disconnect errors */ });
});

server.listen(socketPath, () => {
  process.stdout.write("ready\n");
});

server.on("error", (err: Error) => {
  process.stderr.write(`pit git-helper: ${err.message}\n`);
  process.exit(1);
});
