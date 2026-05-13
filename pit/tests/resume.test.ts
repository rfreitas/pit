/**
 * Tests for session_before_switch cancel behavior.
 *
 * pit -r relies on session_before_switch returning { cancel: true } to prevent
 * the session from opening in the outer (unsandboxed) process. If cancel doesn't
 * work, the session opens without bwrap and the user can write to the wrong path.
 *
 * Confirmed bugs:
 *   - ctx.shutdown() called synchronously BEFORE return { cancel: true } causes
 *     the cancel to fail (cancelled: false, switch happens)
 *   - ctx.shutdown() called asynchronously (Promise/queueMicrotask) throws
 *     "not a function" — context is invalidated after handler returns
 *
 * These tests probe different approaches to find one that both cancels the
 * switch AND closes pi after the user picks a session.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  createAgentSessionRuntime,
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

// ── helpers ───────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

function makeTmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pit-cancel-test-"));
  tmpDirs.push(d);
  return d;
}

function makeSessionFile(cwd: string, agentDir: string): string {
  const bucket = "--" + cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
  const dir = path.join(agentDir, "sessions", bucket);
  fs.mkdirSync(dir, { recursive: true });
  const id = Math.random().toString(16).slice(2, 18);
  const ts = new Date().toISOString();
  const file = path.join(dir, `${ts.replace(/[:]/g, "-").replace(".", "-")}_${id}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: "session", version: 3, id, timestamp: ts, cwd }) + "\n");
  return file;
}

async function makeRuntime(cwd: string, agentDir: string, extensionFactories: ExtensionFactory[] = []) {
  const factory: CreateAgentSessionRuntimeFactory = async ({ cwd: c, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd: c,
      agentDir,
      resourceLoaderOptions: { extensionFactories },
    });
    return {
      ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
      services,
      diagnostics: services.diagnostics,
    };
  };
  return createAgentSessionRuntime(factory, {
    cwd,
    agentDir,
    sessionManager: SessionManager.create(cwd, path.join(agentDir, "sessions")),
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("session_before_switch cancel", () => {
  it("baseline: no cancel registered — switch happens", async () => {
    const agentDir = makeTmpDir();
    const runtime = await makeRuntime(makeTmpDir(), agentDir);
    const originalId = runtime.session.sessionId;
    const result = await runtime.switchSession(makeSessionFile(makeTmpDir(), agentDir));
    expect(result.cancelled).toBe(false);
    expect(runtime.session.sessionId).not.toBe(originalId);
  });

  it("return { cancel: true } alone — switch is cancelled", async () => {
    // Clean cancel with no shutdown. Switch is prevented.
    // Problem: picker stays open, no way to close pi from here.
    const agentDir = makeTmpDir();
    const runtime = await makeRuntime(makeTmpDir(), agentDir, [(pi) => {
      pi.on("session_before_switch", () => ({ cancel: true }));
    }]);
    const originalId = runtime.session.sessionId;
    const result = await runtime.switchSession(makeSessionFile(makeTmpDir(), agentDir));
    expect(result.cancelled).toBe(true);
    expect(runtime.session.sessionId).toBe(originalId);
  });

  it("ctx.shutdown() BEFORE return { cancel: true } — cancel fails (the current pit bug)", async () => {
    // pit's current code calls ctx.shutdown() synchronously before returning.
    // This causes the cancel to be ignored and the session to open.
    const agentDir = makeTmpDir();
    const runtime = await makeRuntime(makeTmpDir(), agentDir, [(pi) => {
      pi.on("session_before_switch", (ctx) => {
        ctx.shutdown(); // ← pit's current code, this breaks cancel
        return { cancel: true };
      });
    }]);
    const originalId = runtime.session.sessionId;
    const result = await runtime.switchSession(makeSessionFile(makeTmpDir(), agentDir));
    // Documents the broken behavior: cancel is ignored when shutdown is called first
    expect(result.cancelled).toBe(false); // BUG: should be true
    expect(runtime.session.sessionId).not.toBe(originalId); // BUG: should be originalId
  });

  it("ctx.shutdown() AFTER return via queueMicrotask — does ctx survive?", async () => {
    // Test whether ctx.shutdown() is still callable after the handler returns.
    // If context is invalidated after return, this will throw.
    const agentDir = makeTmpDir();
    let shutdownError: unknown = null;
    const runtime = await makeRuntime(makeTmpDir(), agentDir, [(pi) => {
      pi.on("session_before_switch", (ctx) => {
        queueMicrotask(() => {
          try { ctx.shutdown(); } catch (e) { shutdownError = e; }
        });
        return { cancel: true };
      });
    }]);
    const originalId = runtime.session.sessionId;
    const result = await runtime.switchSession(makeSessionFile(makeTmpDir(), agentDir));
    await new Promise(r => setTimeout(r, 50)); // let microtask run
    console.log("queueMicrotask shutdown error:", shutdownError);
    console.log("cancelled:", result.cancelled);
    expect(result.cancelled).toBe(true); // cancel must still work
  });

  it("shutdown captured from session_start, called after cancel", async () => {
    // Approach: capture ctx.shutdown from session_start (longer-lived context),
    // call it asynchronously after returning { cancel: true }.
    // session_start context remains valid for the lifetime of the session.
    const agentDir = makeTmpDir();
    let capturedShutdown: (() => void) | null = null;
    let shutdownError: unknown = null;

    const runtime = await makeRuntime(makeTmpDir(), agentDir, [(pi) => {
      pi.on("session_start", (ctx) => {
        capturedShutdown = () => ctx.shutdown();
      });
      pi.on("session_before_switch", () => {
        if (capturedShutdown) {
          queueMicrotask(() => {
            try { capturedShutdown!(); } catch (e) { shutdownError = e; }
          });
        }
        return { cancel: true };
      });
    }]);

    const originalId = runtime.session.sessionId;
    const result = await runtime.switchSession(makeSessionFile(makeTmpDir(), agentDir));
    await new Promise(r => setTimeout(r, 50));

    console.log("capturedShutdown error:", shutdownError);
    console.log("capturedShutdown defined:", !!capturedShutdown);
    console.log("cancelled:", result.cancelled);
    expect(result.cancelled).toBe(true); // cancel works ✓
    // shutdown via captured ctx is the goal — check if error occurred
    expect(shutdownError).toBeNull();
  });
});
