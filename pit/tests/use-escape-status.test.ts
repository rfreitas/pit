/**
 * Tests for useEscapeStatus — the shared subscribe+poll lifecycle helper.
 *
 * Strategy:
 *   - vi.mock ../extensions/escape/client.ts  →  sendEffect returns preset Effects
 *   - vi.mock node:net                         →  createConnection returns a fake socket
 *
 * What's under test:
 *   - Initial fetch on session_start calls sendEffect with the correct op
 *   - format() return value is forwarded to ctx.ui.setStatus
 *   - format() returning undefined still calls setStatus (clears the item)
 *   - A ref-change message on the subscribe socket triggers a re-fetch
 *   - session_shutdown clears the fallback timer and destroys the subscribe socket
 *   - Non-ref-change subscribe messages (ok handshake, error) do not trigger re-fetch
 *   - Malformed JSON on the subscribe socket is silently ignored
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { Effect } from "effect";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── mocks (hoisted) ───────────────────────────────────────────────────────────

vi.mock("../extensions/escape/client.ts", () => ({
  sendEffect: vi.fn(),
}));

vi.mock("node:net", () => ({
  createConnection: vi.fn(),
}));

import { sendEffect } from "../extensions/escape/client.ts";
import { createConnection } from "node:net";
import { useEscapeStatus } from "../extensions/escape/use-escape-status.ts";

// ── fake socket ───────────────────────────────────────────────────────────────

class FakeSocket extends EventEmitter {
  written: string[] = [];
  isDestroyed = false;

  write(data: string) {
    this.written.push(data);
  }
  destroy() {
    this.isDestroyed = true;
    this.emit("close");
  }
}

// ── fake ExtensionAPI ─────────────────────────────────────────────────────────

type SessionEvent = "session_start" | "session_shutdown";
type EventHandler = (event: unknown, ctx: FakeCtx) => Promise<void>;

interface FakeCtx {
  ui: { setStatus: ReturnType<typeof vi.fn> };
}

function makeFakePi() {
  const handlers = new Map<string, EventHandler[]>();

  const pi = {
    on: vi.fn((event: SessionEvent, handler: EventHandler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
  } as unknown as ExtensionAPI;

  const ctx: FakeCtx = {
    ui: { setStatus: vi.fn() },
  };

  async function trigger(event: SessionEvent) {
    for (const h of handlers.get(event) ?? []) {
      await h({}, ctx);
    }
  }

  return { pi, ctx, trigger };
}

// ── helpers ───────────────────────────────────────────────────────────────────

const SOCKET_PATH = "/tmp/fake-pit.sock";
const OP = "test-op";
const KEY = "pit-test";

/** Default format fn: echo the response as JSON */
const echoFormat = (resp: unknown) => JSON.stringify(resp);

/** Drain the microtask / nextTick queue without advancing fake timers. */
const flushPromises = () => new Promise<void>(process.nextTick);

beforeEach(() => {
  vi.useFakeTimers();
  const fakeSocket = new FakeSocket();
  vi.mocked(createConnection).mockReturnValue(fakeSocket as any);
  vi.mocked(sendEffect).mockReturnValue(Effect.succeed({ value: "ok" }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("useEscapeStatus", () => {
  describe("initial fetch on session_start", () => {
    it("calls sendEffect with the correct op", async () => {
      const { pi, trigger } = makeFakePi();
      useEscapeStatus(pi, SOCKET_PATH, OP, KEY, echoFormat);
      await trigger("session_start");
      expect(vi.mocked(sendEffect)).toHaveBeenCalledWith(SOCKET_PATH, { op: OP });
    });

    it("passes sendEffect response through format and into setStatus", async () => {
      const { pi, ctx, trigger } = makeFakePi();
      vi.mocked(sendEffect).mockReturnValue(Effect.succeed({ insertions: 42, deletions: 7 }));
      useEscapeStatus(pi, SOCKET_PATH, OP, KEY, (r: any) => `+${r.insertions} −${r.deletions}`);
      await trigger("session_start");
      expect(ctx.ui.setStatus).toHaveBeenCalledWith(KEY, "+42 −7");
    });

    it("calls setStatus with undefined when format returns undefined", async () => {
      const { pi, ctx, trigger } = makeFakePi();
      useEscapeStatus(pi, SOCKET_PATH, OP, KEY, () => undefined);
      await trigger("session_start");
      expect(ctx.ui.setStatus).toHaveBeenCalledWith(KEY, undefined);
    });
  });

  describe("subscribe socket", () => {
    it("opens a subscribe connection on session_start", async () => {
      const { pi, trigger } = makeFakePi();
      useEscapeStatus(pi, SOCKET_PATH, OP, KEY, echoFormat);
      await trigger("session_start");
      // createConnection: once for the fetch (inside sendEffect mock — skipped),
      // once for the subscribe socket in openSubscription
      expect(vi.mocked(createConnection)).toHaveBeenCalledWith(SOCKET_PATH);
    });

    it("sends subscribe request on connect", async () => {
      const fakeSocket = new FakeSocket();
      vi.mocked(createConnection).mockReturnValue(fakeSocket as any);
      const { pi, trigger } = makeFakePi();
      useEscapeStatus(pi, SOCKET_PATH, OP, KEY, echoFormat);
      await trigger("session_start");
      fakeSocket.emit("connect");
      expect(fakeSocket.written).toContain(JSON.stringify({ op: "subscribe" }) + "\n");
    });

    it("re-fetches when ref-change arrives", async () => {
      const fakeSocket = new FakeSocket();
      vi.mocked(createConnection).mockReturnValue(fakeSocket as any);
      const { pi, ctx, trigger } = makeFakePi();
      vi.mocked(sendEffect)
        .mockReturnValueOnce(Effect.succeed({ v: 1 }))
        .mockReturnValue(Effect.succeed({ v: 2 }));
      useEscapeStatus(pi, SOCKET_PATH, OP, KEY, (r: any) => String(r.v));
      await trigger("session_start");

      // Simulate ref-change push from subscribe socket
      fakeSocket.emit("data", Buffer.from(JSON.stringify({ event: "ref-change" }) + "\n"));
      await flushPromises();

      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(KEY, "2");
      expect(vi.mocked(sendEffect)).toHaveBeenCalledTimes(2);
    });

    it("ignores the ok handshake message", async () => {
      const fakeSocket = new FakeSocket();
      vi.mocked(createConnection).mockReturnValue(fakeSocket as any);
      const { pi, trigger } = makeFakePi();
      useEscapeStatus(pi, SOCKET_PATH, OP, KEY, echoFormat);
      await trigger("session_start");
      const callsBefore = vi.mocked(sendEffect).mock.calls.length;

      fakeSocket.emit("data", Buffer.from(JSON.stringify({ ok: true, watching: "main" }) + "\n"));
      await flushPromises();

      expect(vi.mocked(sendEffect)).toHaveBeenCalledTimes(callsBefore);
    });

    it("ignores malformed JSON on the subscribe socket", async () => {
      const fakeSocket = new FakeSocket();
      vi.mocked(createConnection).mockReturnValue(fakeSocket as any);
      const { pi, trigger } = makeFakePi();
      useEscapeStatus(pi, SOCKET_PATH, OP, KEY, echoFormat);
      await trigger("session_start");
      const callsBefore = vi.mocked(sendEffect).mock.calls.length;

      fakeSocket.emit("data", Buffer.from("not json\n"));
      await flushPromises();

      expect(vi.mocked(sendEffect)).toHaveBeenCalledTimes(callsBefore);
    });

    it("handles data arriving in multiple chunks", async () => {
      const fakeSocket = new FakeSocket();
      vi.mocked(createConnection).mockReturnValue(fakeSocket as any);
      const { pi, ctx, trigger } = makeFakePi();
      vi.mocked(sendEffect)
        .mockReturnValueOnce(Effect.succeed({}))
        .mockReturnValue(Effect.succeed({ v: "chunked" }));
      useEscapeStatus(pi, SOCKET_PATH, OP, KEY, (r: any) => r.v ?? "init");
      await trigger("session_start");

      const msg = JSON.stringify({ event: "ref-change" }) + "\n";
      fakeSocket.emit("data", Buffer.from(msg.slice(0, 5)));
      fakeSocket.emit("data", Buffer.from(msg.slice(5)));
      await flushPromises();

      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(KEY, "chunked");
    });
  });

  describe("fallback poll timer", () => {
    it("re-fetches after FALLBACK_POLL_MS (5 min)", async () => {
      const { pi, ctx, trigger } = makeFakePi();
      vi.mocked(sendEffect)
        .mockReturnValueOnce(Effect.succeed({ v: "initial" }))
        .mockReturnValue(Effect.succeed({ v: "polled" }));
      useEscapeStatus(pi, SOCKET_PATH, OP, KEY, (r: any) => r.v);
      await trigger("session_start");

      await vi.advanceTimersByTimeAsync(5 * 60_000);

      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(KEY, "polled");
    });
  });

  describe("session_shutdown", () => {
    it("destroys the subscribe socket", async () => {
      const fakeSocket = new FakeSocket();
      vi.mocked(createConnection).mockReturnValue(fakeSocket as any);
      const { pi, trigger } = makeFakePi();
      useEscapeStatus(pi, SOCKET_PATH, OP, KEY, echoFormat);
      await trigger("session_start");
      await trigger("session_shutdown");
      expect(fakeSocket.isDestroyed).toBe(true);
    });

    it("stops the fallback timer after shutdown", async () => {
      const { pi, trigger } = makeFakePi();
      vi.mocked(sendEffect).mockReturnValue(Effect.succeed({}));
      useEscapeStatus(pi, SOCKET_PATH, OP, KEY, echoFormat);
      await trigger("session_start");
      const callsAfterStart = vi.mocked(sendEffect).mock.calls.length;

      await trigger("session_shutdown");
      vi.advanceTimersByTime(10 * 60_000);
      await vi.runAllTimersAsync();

      // No additional fetches after shutdown
      expect(vi.mocked(sendEffect)).toHaveBeenCalledTimes(callsAfterStart);
    });
  });
});
