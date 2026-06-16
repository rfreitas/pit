# Pi Ollama Extensions Review

I have reviewed the top Ollama extensions available for Pi on NPM. Below is a deep dive into what each package actually does, followed by a comparison table.

## Deep Dive

### 1. `@jamesjfoong/pi-ollama`
This is arguably the most feature-rich extension for managing how Pi configures Ollama models. 
* **Key Features:** It features an interactive TUI (Terminal UI) wizard (`/ollama-setup`) that lets you configure endpoints and API key pools without editing JSON files. It intelligently queries Ollama's `/api/show` endpoint to figure out the exact context window, vision support, and thinking capabilities of each model.
* **Standout Feature:** It includes a `/ollama-fix` command that provides guided, interactive fixes for models that have incorrect metadata (e.g., a model that claims to support vision but actually crashes). It also implements caching so Pi can boot up offline using the last known model list.

### 2. `@0xkobold/pi-ollama`
This package is very similar to James's package (in fact, they likely share a codebase or lineage given their similar feature sets). 
* **Key Features:** It focuses heavily on "unified" local and cloud support. It also queries `/api/show` to properly set context lengths and automatically detects if a model is a reasoning model (like `deepseek-r1`) so Pi handles its `<think>` tags correctly.
* **Standout Feature:** Extremely robust HTTP error handling. It categorizes rate limits, auth errors, and server errors into typed classes and can rotate through a pool of API keys if one fails (useful for Ollama Cloud).

### 3. `@vtstech/pi-ollama-sync`
This is a more minimalist tool designed for users who prefer keeping their configuration in Pi's native `models.json` file but hate updating it manually.
* **Key Features:** It provides a `/ollama-sync` command. When you run it, the extension queries your Ollama instance (local or a remote tunnel), sorts all your installed models by size, auto-detects reasoning models, and directly overwrites your `models.json` file with the correct configurations.
* **Standout Feature:** It's very transparent. Instead of doing magic in the background, it just automates the generation of the standard Pi config file.

### 4. `pi-ollama-cloud`
This extension skips your local Ollama server entirely and is designed exclusively for users who want to use the hosted `ollama.com` cloud API.
* **Key Features:** It registers an entirely separate provider (`ollama-cloud`) so you can run local models via the standard integration, and cloud models via this extension simultaneously without conflicts. 
* **Standout Feature:** It comes bundled with `ollama_web_search` and `ollama_web_fetch` tools that use Ollama's cloud infrastructure to browse the web, saving your local bandwidth and compute.

---

## Handling of `models.json`

Hardcoding dynamic models into a static `models.json` file leads to them quickly becoming out of sync when you pull or delete models via the Ollama CLI. Here is how they differ:

* **The Dynamic Approach (Ideal): `@jamesjfoong` & `@0xkobold`**
  These extensions do exactly what you suggested. They **skip** the `models` array in your `models.json` file entirely. When Pi starts, the extension pings your Ollama API, discovers exactly what models are available at that second, and registers them dynamically in Pi's memory. The documentation even explicitly tells you to delete the static `models` array from your `models.json` file because the extension takes over entirely.
* **The Static Approach: `@vtstech`**
  This extension takes the opposite approach. Its entire purpose is to query Ollama and **hard-write** the results directly into your `models.json` file. This means if you pull a new model tomorrow, Pi won't see it until you manually run `/ollama-sync` again to update the file.
* **The Cloud Approach: `pi-ollama-cloud`**
  Since it deals with cloud models, it also skips `models.json`. It fetches the list of available cloud models from the internet and registers them in memory (caching them to a separate `~/.pi/agent/cache/ollama-cloud-models.json` file for offline starts).

---

## Feature Comparison Table

| Feature / Extension | `@jamesjfoong` | `@0xkobold` | `@vtstech` | `pi-ollama-cloud` |
| :--- | :---: | :---: | :---: | :---: |
| **Interactive Setup (TUI)** | ✅ Yes (`/ollama-setup`) | ❌ No | ❌ No | ❌ No |
| **Auto-Discovers Models** | ✅ Yes | ✅ Yes | ✅ Yes (Manual Trigger) | ✅ Yes (Cloud only) |
| **Context Length Detection** | ✅ Yes (via `/api/show`) | ✅ Yes (via `/api/show`) | ❌ No | ❌ No |
| **Reasoning Auto-Detect** | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |
| **Guided Model Fixes** | ✅ Yes (`/ollama-fix`) | ❌ No | ❌ No | ❌ No |
| **API Key Rotation** | ✅ Yes | ✅ Yes | ❌ No | ❌ No |
| **Modifies `models.json`** | ❌ No (Loads in memory) | ❌ No (Loads in memory) | ✅ Yes | ❌ No |
| **Web Search Tools Built-in**| ❌ No | ❌ No | ❌ No | ✅ Yes |
| **Memory Eject (Free VRAM)** | ❌ No | ❌ No | ❌ No | ❌ No |

## Summary
If you want the most polished configuration experience, **`@jamesjfoong/pi-ollama`** is the winner due to its TUI setup and caching. If you want a simple utility that just updates your standard Pi files, **`@vtstech/pi-ollama-sync`** is best. 

However, as the table shows, **none of them handle automatic memory ejection** to solve the VRAM crashes you mentioned earlier. We still need to build that custom extension to get that specific behavior!
