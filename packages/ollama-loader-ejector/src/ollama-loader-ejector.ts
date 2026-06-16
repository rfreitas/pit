/**
 * ollama-loader-ejector — Pi extension
 *
 * Before every Ollama LLM request:
 *   1. Checks Ollama is reachable; if not, restarts it via brew and waits.
 *   2. Ejects any model currently in VRAM that is not the one Pi is about to use.
 *
 * See plans/ollama-loader-ejector.md for the full design rationale.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const OLLAMA_BASE = "http://localhost:11434";
const RESTART_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FetchFn = typeof fetch;
type ExecFn = (cmd: string, args: string[]) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Parse the list of loaded model names from an /api/ps response body.
 * Returns [] for any invalid/missing input — never throws.
 */
export function parseLoadedModels(body: unknown): string[] {
	if (!body || typeof body !== "object") return [];
	const { models } = body as Record<string, unknown>;
	if (!Array.isArray(models)) return [];
	return models
		.filter((m): m is Record<string, unknown> => m !== null && typeof m === "object")
		.filter((m) => typeof m["name"] === "string")
		.map((m) => m["name"] as string);
}

/**
 * Given the currently loaded model names and the target model id,
 * return the subset that should be ejected (i.e. everything that isn't the target).
 */
export function modelsToEject(loaded: string[], targetModelId: string): string[] {
	return loaded.filter((name) => name !== targetModelId);
}

/**
 * Check whether Ollama is reachable. Returns true if healthy, false otherwise.
 * Never throws.
 */
export async function checkHealth(fetchFn: FetchFn): Promise<boolean> {
	try {
		const res = await fetchFn(`${OLLAMA_BASE}/`, { signal: AbortSignal.timeout(3_000) });
		return res.ok;
	} catch {
		return false;
	}
}

/**
 * Eject a single model from VRAM by sending keep_alive: 0.
 * Silently swallows errors — a failed eject is non-fatal.
 */
export async function ejectModel(fetchFn: FetchFn, modelName: string): Promise<void> {
	try {
		await fetchFn(`${OLLAMA_BASE}/api/generate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: modelName, keep_alive: 0 }),
			signal: AbortSignal.timeout(10_000),
		});
	} catch {
		// Non-fatal — best-effort eject
	}
}

/**
 * Ensure Ollama is running within the given timeout.
 *
 * - If Ollama is already up: returns true immediately (no restart).
 * - If Ollama is down: triggers `brew services restart ollama`, then polls
 *   until it responds or the timeout elapses.
 *
 * Returns true if Ollama is up at the end, false if it timed out.
 */
export async function waitForOllama(
	fetchFn: FetchFn,
	execFn: ExecFn,
	timeoutMs: number,
	pollIntervalMs: number,
): Promise<boolean> {
	// If already up, nothing to do
	if (await checkHealth(fetchFn)) return true;

	// Trigger restart (fire-and-forget — process may die before responding)
	void execFn("brew", ["services", "restart", "ollama"]).catch(() => undefined);

	// Poll until healthy or timeout
	const deadline = Date.now() + timeoutMs;
	await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
	while (Date.now() < deadline) {
		if (await checkHealth(fetchFn)) return true;
		await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
	}
	return false;
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const fetchFn: FetchFn = fetch;
	const execFn: ExecFn = async (cmd, args) => {
		const result = await execFileAsync(cmd, args);
		return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
	};

	pi.on("before_provider_request", async (_event, ctx) => {
		if (ctx.model?.provider !== "ollama") return;

		// Step 1: ensure Ollama is up
		const healthy = await checkHealth(fetchFn);
		if (!healthy) {
			ctx.ui.setFooter("⏳ Ollama down — restarting…");
			const recovered = await waitForOllama(fetchFn, execFn, RESTART_TIMEOUT_MS, POLL_INTERVAL_MS);
			if (!recovered) {
				ctx.ui.setFooter("❌ Ollama not responding — Pi will retry");
				return;
			}
			ctx.ui.setFooter(undefined);
		}

		// Step 2: eject models that aren't the one Pi wants
		const psRes = await fetchFn(`${OLLAMA_BASE}/api/ps`, {
			signal: AbortSignal.timeout(5_000),
		}).catch(() => null);
		if (!psRes?.ok) return;

		const body = await psRes.json().catch(() => null);
		const loaded = parseLoadedModels(body);
		const toEject = modelsToEject(loaded, ctx.model.id);

		for (const model of toEject) {
			ctx.ui.setFooter(`⏳ Ejecting ${model}…`);
			await ejectModel(fetchFn, model);
		}

		if (toEject.length > 0) {
			ctx.ui.setFooter(undefined);
		}
	});
}
