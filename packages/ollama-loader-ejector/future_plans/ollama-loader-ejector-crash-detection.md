# Future Plan: Mid-Stream Crash Detection via Health-Check Poller

## Problem

When Ollama is OOM-killed mid-stream, it often does not send a TCP FIN packet. The OS TCP stack keeps the connection in `ESTABLISHED` state and Pi's HTTP client (`undici`) waits for streaming data that will never arrive.

Pi's default `httpIdleTimeoutMs` is **5 minutes**. This means Pi appears frozen for up to 5 minutes after a crash, with no feedback to the user.

The current mitigation (setting `httpIdleTimeoutMs: 30000`) helps but is passive — it still means a 30-second wait before Pi automatically recovers.

## Proposed Solution

Run a **background health-check poller** while a Pi LLM request is in flight. Because the poller uses a fresh TCP connection (not the hanging stream socket), it detects a crashed Ollama within **≤ the poll interval** (e.g. 3 seconds).

### How it would work

```
before_provider_request fires
  → set inFlight = true, capture ctx
  → start setInterval (every 3s) if not already running

[Ollama OOM-killed, stream socket hangs]
  → poller fires → GET http://localhost:11434/ → connection refused (fast fail!)
  → inFlight is true → call ctx.abort()
  → Pi cancels the hanging request immediately (≤ 3s instead of up to 5 min)
  → footer: "⚠️ Ollama crashed — re-send to recover"

agent_end fires (turn ended, any outcome)
  → set inFlight = false
  → poller self-terminates on next tick

user re-sends message
  → before_provider_request fires
  → hook detects Ollama is down → restarts it → proceeds cleanly
```

### Hooks needed

| Pi Event | Purpose |
| :--- | :--- |
| `before_provider_request` | Set `inFlight = true`, start poller if not running |
| `agent_end` | Set `inFlight = false` so poller stops |

## Why This Is Deferred

`ctx.abort()` sets `stopReason = "aborted"` on the cancelled message. Pi's retry mechanism (`_handlePostAgentRun` in `agent-session.js`) **only retries when `stopReason === "error"`**. An abort is treated as a user cancellation — Pi returns to idle state without retrying.

This means after the poller calls `ctx.abort()`, the user must **manually re-send** the message. At that point our `before_provider_request` hook runs, detects Ollama is down, restarts it, and the request proceeds.

This is a meaningful UX improvement over a 5-minute hang, but it's not fully automatic. The ideal behaviour would be:

```
Ollama crashes
  → poller detects it in ≤ 3s
  → terminates the request with an error (not an abort)
  → Pi's retry mechanism fires automatically
  → before_provider_request hook restarts Ollama
  → request succeeds on retry — no user action needed
```

## Blocking Requirement

This plan requires Pi to expose a way to **terminate the current streaming request with an error `stopReason`** from an extension. As of the time this was written, no such API exists — only `ctx.abort()`, which produces `stopReason = "aborted"` and bypasses retry.

**Revisit when:** Pi exposes an `ctx.abortWithError(message)` API or equivalent, or if Ollama starts consistently closing the TCP connection on OOM (which would let Pi detect the error naturally and retry without any extension involvement).

## References

- Verified in `agent-session.js` `_handlePostAgentRun()` — retry gated on `stopReason === "error"`
- Verified in `runner.js` `emitBeforeProviderRequest()` — handler errors swallowed, cannot abort from hook
- Verified in `http-dispatcher.js` — default `bodyTimeout` is 300,000ms (5 min)
- `ctx.abort()` available on `ExtensionContext` — confirmed in `types.d.ts` and `runner.js`
