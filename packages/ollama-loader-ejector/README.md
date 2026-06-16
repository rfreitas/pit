# pi-ollama-loader-ejector

> Pi extension — ejects stale Ollama models from VRAM and restarts Ollama if it's down, before each request.

## What it does

Before every LLM request to an Ollama model, this extension:

1. **Checks Ollama is reachable.** If not, runs `brew services restart ollama` and waits up to 15 seconds. While waiting, a status message appears in the Pi footer. If Ollama doesn't recover in time, the request proceeds anyway — Pi's built-in retry mechanism will re-fire the hook on the next attempt.

2. **Ejects any model currently in VRAM that isn't the one Pi is about to use.** Ollama only has enough VRAM for one model at a time on most hardware. By ejecting the stale model before loading the new one, you avoid the OOM crash that happens when Ollama tries to load two models simultaneously.

## Why

Pi switches between models freely. Without this extension, switching from `gemma4:26b` to `llama3:8b` while the first model is still in VRAM causes Ollama to OOM-crash mid-load. This extension makes model switching seamless.

## Installation

### Local (development)

Add the source file directly to your Pi `settings.json`:

```json
{
  "packages": [
    "~/path/to/pi/packages/ollama-loader-ejector/src/ollama-loader-ejector.ts"
  ]
}
```

Edits to the source are picked up on `/reload` — no build step needed.

### From npm

```json
{
  "packages": [
    "npm:@ricfr/pi-ollama-loader-ejector"
  ]
}
```

## Requirements

- **Ollama** running locally on `http://localhost:11434`
- **Homebrew** — used to restart Ollama if it's down (`brew services restart ollama`)
- **Pi** with `before_provider_request` event support

## Known limitations

- Hardcoded to `localhost:11434` (configurable URL planned)
- Restart assumes a Homebrew-managed Ollama install — non-brew installations won't be restarted automatically
- Mid-stream Ollama crashes (OOM-kill with hanging socket) leave Pi stuck until Pi's `httpIdleTimeoutMs` fires. Recommended mitigation: set `httpIdleTimeoutMs` to `30000` (30s) in Pi settings so the timeout fires quickly and Pi's retry re-runs the hook

## Pairs well with

[`@jamesjfoong/pi-ollama`](https://www.npmjs.com/package/@jamesjfoong/pi-ollama) — discovers locally installed Ollama models at startup and registers them in Pi's model list. Install both; they don't conflict.

| Extension | Phase | Responsibility |
| :--- | :--- | :--- |
| `@jamesjfoong/pi-ollama` | Startup | Discover and register installed models |
| `pi-ollama-loader-ejector` | Per-request | Keep Ollama alive and VRAM clean |
