# Ollama Loader Ejector Extension — Plan

## Goal

A lightweight Pi extension (`extensions/ollama-loader-ejector.ts`) that intercepts every request Pi makes to an Ollama model and ensures:

1. **Ollama is reachable.** If not, attempt a restart via `brew services restart ollama` and wait. If it doesn't recover in time, return normally — Pi's HTTP call will fail, triggering Pi's built-in retry, which re-fires our hook.
2. **The right model is in VRAM.** Query `/api/ps`. If a different model is currently loaded, eject it before the request goes through.

---

## Design Decisions

| Decision | Choice | Rationale |
| :--- | :--- | :--- |
| Restart mechanism | `brew services restart ollama` | Already used by the system (brew-managed service) |
| Restart timeout | 15 seconds | Enough for Ollama to cold-start; fail fast after that |
| Ollama URL | Always `http://localhost:11434` | Keep it simple; configurable later if needed |
| Footer status during wait | `⏳ Ollama: ejecting <old> → loading <new>…` | Visible but not intrusive |
| Recovery on timeout | Return normally; Pi's HTTP call fails → Pi auto-retries → hook re-runs | No complex in-extension retry loop needed |
| Works alongside `@jamesjfoong` | Yes — no shared state, different lifecycle hooks | `@jamesjfoong` handles discovery; this handles runtime memory |

---

## Pi's Built-in Retry Mechanism

> Verified directly from Pi's source code (`agent-session.js`, `http-dispatcher.js`).

Pi has a built-in auto-retry system. When an LLM request fails with a retryable error, Pi:

1. Waits with exponential backoff (default: 2s → 4s → 8s, up to 3 attempts)
2. Shows "Retrying (1/3) in 2s…" in the TUI — abortable with Escape
3. **Re-fires `before_provider_request` on each retry attempt**

Pi classifies the following as **retryable errors**:
- `connection refused` / `connection lost` / `fetch failed` / `socket hang up`
- `500` / `502` / `503` / `504` / `service unavailable` / `timed out`

If our hook times out waiting for Ollama to restart, it returns normally. Pi's HTTP call will then fail with one of the above errors, triggering the retry loop, which re-fires our hook. The hook retries the Ollama restart on each attempt.

### The Hanging Socket Problem (Known Limitation)

When Ollama is OOM-killed, it often does not send a TCP FIN packet. Pi's HTTP client (`undici`) waits for streaming data that never arrives. Pi's default `httpIdleTimeoutMs` is **5 minutes** — so Pi can appear stuck for up to that long.

**Mitigation:** Set `httpIdleTimeoutMs` to **30s** in Pi's settings. With this, Pi times out in 30 seconds, retries, and our hook gets to restart Ollama automatically.

Set via `/settings` inside Pi, or directly in `~/.pi/agent/settings.json`:
```json
{ "httpIdleTimeoutMs": 30000 }
```

> [!NOTE]
> Mid-stream crash recovery via a background health-check poller (using `ctx.abort()`) was investigated but deferred. `ctx.abort()` sets `stopReason = "aborted"`, which bypasses Pi's retry mechanism — the user would have to re-send manually. The `httpIdleTimeoutMs` approach is simpler and fully automatic. A poller-based approach may be revisited if Pi exposes an API to terminate requests with an error `stopReason` in the future.

---

## Key Constraint: Handler Errors Are Swallowed

> Verified in `runner.js` `emitBeforeProviderRequest()` (lines 732–741).

If our `before_provider_request` handler throws, Pi catches it, logs it as an extension error, and proceeds with the request anyway. We cannot abort a request from this hook. This is fine — it means if Ollama is still down after our 15s restart attempt, Pi makes the HTTP call, fails, and retries via its own mechanism.

---

## Hook Used

| Pi Event | When it fires | What we do |
| :--- | :--- | :--- |
| `before_provider_request` | Before every LLM HTTP call (including Pi's auto-retries) | Health check + restart if needed; eject wrong models from VRAM |

One hook. No other hooks needed.

---

## Logic Flow

### `before_provider_request`

```
1. Is ctx.model.provider === "ollama"?
   └─ No  → return immediately.
   └─ Yes → continue.

2. GET http://localhost:11434/
   └─ Success → Ollama is up, go to step 3.
   └─ Failure → set footer "⏳ Ollama down — restarting…"
                run `brew services restart ollama`
                poll every 500ms up to 15s
                └─ Comes back → clear footer, go to step 3.
                └─ Timeout    → clear footer
                               set footer "❌ Ollama not responding — Pi will retry"
                               return normally
                               (Pi's HTTP call fails → Pi retries → hook runs again)

3. GET http://localhost:11434/api/ps  (loaded models)
   └─ No models loaded → return, let Pi proceed.
   └─ Model in VRAM matches ctx.model.id → return, let Pi proceed.
   └─ Different model(s) loaded → for each loaded model:
        set footer "⏳ Ejecting <model>…"
        POST /api/generate { model: <model>, keep_alive: 0 }
     → clear footer, return, let Pi proceed.
```

---

## File

| Path | Description |
| :--- | :--- |
| `extensions/ollama-loader-ejector.ts` | The extension. Single self-contained file, no build step. |

No new dependencies. Uses only `fetch()` (Node 18+, available in Pi's runtime) and `pi.exec()` from the Extension API.

---

## Pairing with `@jamesjfoong/pi-ollama`

These two extensions complement each other cleanly:

| Extension | Lifecycle Phase | Responsibility |
| :--- | :--- | :--- |
| `@jamesjfoong/pi-ollama` | Startup | Discover installed models, register them dynamically |
| `ollama-loader-ejector.ts` | Per-request | Ensure Ollama is alive and only the right model is in VRAM |

Install both; they do not conflict.

---

## Out of Scope (for now)

- Configurable Ollama URL (hardcoded to `localhost:11434`)
- Non-brew Ollama installations
- Pulling a missing model automatically
- Background health-check poller + `ctx.abort()` for mid-stream crash recovery (deferred — needs Pi API for error-stopReason termination to be useful)

---

## Verification

1. Start Pi with `ollama-loader-ejector.ts` loaded alongside `@jamesjfoong/pi-ollama`.
2. In a separate terminal, load a model: `ollama run llama3`.
3. In Pi, switch to a different Ollama model and send a prompt.
4. Verify the footer shows the eject message, then `ollama ps` confirms only the new model is loaded.
5. Kill Ollama manually (`pkill ollama`), then send a Pi prompt.
6. Verify Pi shows the restart notice, Ollama comes back, and Pi proceeds cleanly on retry.
7. Set `httpIdleTimeoutMs: 30000` and verify that an OOM-like hang auto-recovers within ~30s.
