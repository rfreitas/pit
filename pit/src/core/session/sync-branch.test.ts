/**
 * Tests for the pit sync-branch hook.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSyncBranchHook } from "./sync-branch.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

function makeTmp(prefix = "sync-branch-test-"): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function makeLinkedWorktree(cwd: string, branch: string, mainRepo: string): void {
  const gitdir = path.join(mainRepo, ".git", "worktrees", "wt");
  fs.mkdirSync(gitdir, { recursive: true });
  fs.writeFileSync(path.join(gitdir, "HEAD"), `ref: refs/heads/${branch}\n`);
  fs.writeFileSync(path.join(cwd, ".git"), `gitdir: ${gitdir}\n`);
}

function makeMockApi() {
  let sessionStartHandler: ((event: unknown, ctx: { cwd: string; sessionManager?: { getSessionFile: () => string } }) => Promise<void>) | undefined;

  const api = {
    on: vi.fn((event: string, handler: typeof sessionStartHandler) => {
      if (event === "session_start") sessionStartHandler = handler;
    }),
  } as unknown as ExtensionAPI;

  const triggerSessionStart = async (cwd: string, sessionFile?: string) => {
    await sessionStartHandler?.("session_start", {
      cwd,
      sessionManager: sessionFile ? { getSessionFile: () => sessionFile } : undefined
    });
  };

  return { api, triggerSessionStart };
}

describe("createSyncBranchHook", () => {
  it("rewrites session file on ref-change event", async () => {
    const socketPath = makeTmp("sock-") + "/test.sock";
    let clientSock: net.Socket | undefined;
    const server = net.createServer((sock) => {
      clientSock = sock;
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const cwd = makeTmp("wt-");
    const mainRepo = makeTmp("repo-");
    makeLinkedWorktree(cwd, "pi/old-branch", mainRepo);

    const sessionFile = path.join(cwd, "session.jsonl");
    fs.writeFileSync(
      sessionFile,
      `{"type":"session","cwd":"${cwd}"}\n{"type":"custom","customType":"pit","data":{"branch":"pi/old-branch"}}\n`
    );

    const { api, triggerSessionStart } = makeMockApi();
    createSyncBranchHook(socketPath, "fake-token")(api);
    await triggerSessionStart(cwd, sessionFile);

    await new Promise<void>((resolve) => {
      if (clientSock) resolve();
      else server.on("connection", () => resolve());
    });

    makeLinkedWorktree(cwd, "pi/new-branch", mainRepo);

    clientSock!.write(JSON.stringify({ event: "ref-change" }) + "\n");

    await new Promise((r) => setTimeout(r, 50));

    const content = fs.readFileSync(sessionFile, "utf8");
    expect(content).toContain('"branch":"pi/new-branch"');
    expect(content).not.toContain('"branch":"pi/old-branch"');

    server.close();
  });
});
