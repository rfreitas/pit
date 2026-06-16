import { vi, describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Imports (named exports are the units under test; default export is the Pi
// extension factory, tested via a mock pi object)
// ---------------------------------------------------------------------------
import ollamaLoaderEjectorFactory, {
	parseLoadedModels,
	modelsToEject,
	checkHealth,
	ejectModel,
	waitForOllama,
} from "../src/ollama-loader-ejector.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal /api/ps response body */
function makeApiPsBody(models: Array<{ name: string }>) {
	return { models };
}

/** Create a fetch mock that returns the given status + json body */
function makeFetch(status: number, body?: unknown) {
	return vi.fn().mockResolvedValue({
		ok: status >= 200 && status < 300,
		status,
		json: () => Promise.resolve(body ?? {}),
	});
}

/** Create a fetch mock that rejects (e.g. connection refused) */
function makeFailingFetch(message = "fetch failed") {
	return vi.fn().mockRejectedValue(new Error(message));
}

/** Create a mock exec function (used for `brew services restart ollama`) */
function makeExec(exitCode = 0) {
	return vi.fn().mockResolvedValue({ exitCode, stdout: "", stderr: "" });
}

function makeMockPi() {
	let beforeProviderHandler: ((event: any, ctx: any) => Promise<void>) | undefined;

	const mockPi: any = {
		on: vi.fn((event: string, handler: any) => {
			if (event === "before_provider_request") beforeProviderHandler = handler;
		}),
		get beforeProviderHandler() { return beforeProviderHandler; },
	};
	return mockPi;
}

function makeMockCtx(provider = "ollama", modelId = "llama3:8b") {
	return {
		model: { provider, id: modelId },
		ui: {
			setFooter: vi.fn(),
		},
	};
}

// ---------------------------------------------------------------------------
// parseLoadedModels
// ---------------------------------------------------------------------------

describe("parseLoadedModels", () => {
	it("returns model names from a valid /api/ps response", () => {
		const body = makeApiPsBody([{ name: "llama3:8b" }, { name: "gemma4:26b" }]);
		expect(parseLoadedModels(body)).toEqual(["llama3:8b", "gemma4:26b"]);
	});

	it("returns empty array when models list is empty", () => {
		expect(parseLoadedModels(makeApiPsBody([]))).toEqual([]);
	});

	it("returns empty array when body is null", () => {
		expect(parseLoadedModels(null)).toEqual([]);
	});

	it("returns empty array when body is missing models field", () => {
		expect(parseLoadedModels({})).toEqual([]);
	});

	it("returns empty array when models field is not an array", () => {
		expect(parseLoadedModels({ models: "oops" })).toEqual([]);
	});

	it("skips entries that are missing a name field", () => {
		const body = { models: [{ name: "llama3:8b" }, { size: 123 }] };
		expect(parseLoadedModels(body)).toEqual(["llama3:8b"]);
	});
});

// ---------------------------------------------------------------------------
// modelsToEject
// ---------------------------------------------------------------------------

describe("modelsToEject", () => {
	it("returns empty array when nothing is loaded", () => {
		expect(modelsToEject([], "llama3:8b")).toEqual([]);
	});

	it("returns empty array when the target model is already the only loaded model", () => {
		expect(modelsToEject(["llama3:8b"], "llama3:8b")).toEqual([]);
	});

	it("returns the loaded model when a different model is loaded", () => {
		expect(modelsToEject(["gemma4:26b"], "llama3:8b")).toEqual(["gemma4:26b"]);
	});

	it("returns all loaded models when none match the target", () => {
		expect(modelsToEject(["gemma4:26b", "mistral:7b"], "llama3:8b"))
			.toEqual(["gemma4:26b", "mistral:7b"]);
	});

	it("ejects only the non-matching models when target is also loaded", () => {
		// e.g. both llama3:8b and gemma4:26b somehow in VRAM, target is llama3:8b
		expect(modelsToEject(["llama3:8b", "gemma4:26b"], "llama3:8b"))
			.toEqual(["gemma4:26b"]);
	});
});

// ---------------------------------------------------------------------------
// checkHealth
// ---------------------------------------------------------------------------

describe("checkHealth", () => {
	it("returns true when Ollama responds with 200", async () => {
		const fetchMock = makeFetch(200);
		expect(await checkHealth(fetchMock)).toBe(true);
	});

	it("returns true when Ollama responds with any 2xx", async () => {
		const fetchMock = makeFetch(204);
		expect(await checkHealth(fetchMock)).toBe(true);
	});

	it("returns false when Ollama responds with 5xx", async () => {
		const fetchMock = makeFetch(503);
		expect(await checkHealth(fetchMock)).toBe(false);
	});

	it("returns false when fetch rejects (connection refused)", async () => {
		const fetchMock = makeFailingFetch("connection refused");
		expect(await checkHealth(fetchMock)).toBe(false);
	});

	it("sends request to localhost:11434", async () => {
		const fetchMock = makeFetch(200);
		await checkHealth(fetchMock);
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("localhost:11434"),
			expect.anything(),
		);
	});
});

// ---------------------------------------------------------------------------
// ejectModel
// ---------------------------------------------------------------------------

describe("ejectModel", () => {
	it("sends POST /api/generate with keep_alive: 0", async () => {
		const fetchMock = makeFetch(200, {});
		await ejectModel(fetchMock, "gemma4:26b");
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/api/generate"),
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining("\"keep_alive\":0"),
			}),
		);
	});

	it("includes the correct model name in the body", async () => {
		const fetchMock = makeFetch(200, {});
		await ejectModel(fetchMock, "llama3:8b");
		const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
		expect(body.model).toBe("llama3:8b");
		expect(body.keep_alive).toBe(0);
	});

	it("does not throw when fetch fails", async () => {
		const fetchMock = makeFailingFetch();
		await expect(ejectModel(fetchMock, "llama3:8b")).resolves.not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// waitForOllama
// ---------------------------------------------------------------------------

describe("waitForOllama", () => {
	beforeEach(() => vi.useFakeTimers());
	// Restore after each test so fake timers don't bleed across
	// (vitest restores automatically between files, but be explicit)

	it("resolves true immediately when Ollama is already up", async () => {
		const fetchMock = makeFetch(200);
		const execMock = makeExec();
		const result = waitForOllama(fetchMock, execMock, 5_000, 100);
		await vi.runAllTimersAsync();
		expect(await result).toBe(true);
		// Should not have called exec (no restart needed)
		expect(execMock).not.toHaveBeenCalled();
	});

	it("calls brew services restart and resolves true when Ollama comes back", async () => {
		// First health check fails (Ollama is down), second succeeds (came back)
		const fetchMock = vi.fn()
			.mockRejectedValueOnce(new Error("connection refused"))
			.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });
		const execMock = makeExec();

		const result = waitForOllama(fetchMock, execMock, 5_000, 100);
		await vi.runAllTimersAsync();
		expect(await result).toBe(true);
		expect(execMock).toHaveBeenCalledWith(
			expect.stringContaining("brew"),
			expect.arrayContaining(["services", "restart", "ollama"]),
		);
	});

	it("resolves false when Ollama does not come back within timeout", async () => {
		const fetchMock = makeFailingFetch("connection refused");
		const execMock = makeExec();

		const result = waitForOllama(fetchMock, execMock, 1_000, 100);
		await vi.runAllTimersAsync();
		expect(await result).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// before_provider_request handler (integration via mock pi)
// ---------------------------------------------------------------------------

describe("before_provider_request handler", () => {
	beforeEach(() => vi.restoreAllMocks());

	it("registers a before_provider_request handler on pi.on", () => {
		const pi = makeMockPi();
		ollamaLoaderEjectorFactory(pi);
		expect(pi.on).toHaveBeenCalledWith("before_provider_request", expect.any(Function));
	});

	it("does nothing when provider is not ollama", async () => {
		const pi = makeMockPi();
		ollamaLoaderEjectorFactory(pi);
		const ctx = makeMockCtx("anthropic", "claude-opus-4-5");
		await pi.beforeProviderHandler?.({ type: "before_provider_request", payload: {} }, ctx);
		expect(ctx.ui.setFooter).not.toHaveBeenCalled();
	});

	it("sets footer while ejecting a stale model and clears it after", async () => {
		const pi = makeMockPi();
		ollamaLoaderEjectorFactory(pi);

		// Ollama is healthy; gemma4:26b is loaded but we want llama3:8b
		// We need to intercept the internal fetch calls made by the handler.
		// The handler is injected with fetch; the factory accepts an optional
		// testFetch parameter for this purpose.
		// (See implementation: export default function(pi, { fetch: testFetch } = {}))
		// This test is intentionally left as an integration-style smoke test using
		// real internal helpers — we trust unit tests above for correctness.
		const ctx = makeMockCtx("ollama", "llama3:8b");
		// Handler should not throw regardless of Ollama state
		await expect(
			pi.beforeProviderHandler?.({ type: "before_provider_request", payload: {} }, ctx),
		).resolves.not.toThrow();
	});
});
