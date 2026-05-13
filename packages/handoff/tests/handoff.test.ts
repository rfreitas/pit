import { vi, describe, it, expect, beforeEach, type MockedFunction } from "vitest";

// fs must be mocked before the module under test is imported.
// Only stub the functions handoff.ts actually uses.
vi.mock("fs", () => ({
	existsSync: vi.fn(),
	readdirSync: vi.fn(),
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
	mkdirSync: vi.fn(),
	unlinkSync: vi.fn(),
	realpathSync: vi.fn(),
}));

import * as fs from "fs";
import handoffFactory, {
	pathToBucketName,
	getDirectoryCompletions,
} from "../src/handoff.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSIONS_DIR = "/home/ricfr/.pi/agent/sessions";
const CURRENT_BUCKET = "--home-ricfr-current--";
const SESSION_FILE = `${SESSIONS_DIR}/${CURRENT_BUCKET}/2024-01-01T00-00-00-000Z_abc.jsonl`;

/** Minimal valid two-line session JSONL */
function makeSessionContent(cwd = "/home/ricfr/current") {
	return [
		JSON.stringify({ type: "session", id: "sess-1", version: 3, cwd, timestamp: "2024-01-01T00:00:00.000Z" }),
		JSON.stringify({ type: "message", id: "msg-1", parentId: null, timestamp: "2024-01-01T00:00:01.000Z", message: { role: "user", content: "hello" } }),
	].join("\n") + "\n";
}

function makeMockPi() {
	let sessionStartHandler: ((event: any, ctx: any) => void) | undefined;
	let handoffHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
	let completionsHandler: ((prefix: string) => any[] | null) | undefined;

	const mockPi: any = {
		on: vi.fn((event: string, handler: any) => {
			if (event === "session_start") sessionStartHandler = handler;
		}),
		registerCommand: vi.fn((_name: string, options: any) => {
			handoffHandler = options.handler;
			completionsHandler = options.getArgumentCompletions;
		}),
		getSessionName: vi.fn(() => undefined),
		get sessionStartHandler() { return sessionStartHandler; },
		get handoffHandler() { return handoffHandler; },
		get completionsHandler() { return completionsHandler; },
	};
	return mockPi;
}

function makeMockCtx(overrides: Partial<any> = {}) {
	const newCtx = { ui: { notify: vi.fn(), setStatus: vi.fn() } };
	return {
		cwd: "/home/ricfr/current",
		ui: { notify: vi.fn(), setStatus: vi.fn() },
		sessionManager: { getSessionFile: vi.fn(() => SESSION_FILE) },
		switchSession: vi.fn(async (_file: string, opts: any) => {
			await opts?.withSession?.(newCtx);
			return { cancelled: false };
		}),
		_newCtx: newCtx,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// pathToBucketName
// ---------------------------------------------------------------------------

describe("pathToBucketName", () => {
	it("strips leading slash on WSL path", () => {
		expect(pathToBucketName("/mnt/c/Users/ricfr/Repos/agent"))
			.toBe("--mnt-c-Users-ricfr-Repos-agent--");
	});

	it("strips leading backslash", () => {
		expect(pathToBucketName("\\server\\share\\dir"))
			.toBe("--server-share-dir--");
	});

	it("replaces colon on Windows-style path", () => {
		expect(pathToBucketName("C:\\Users\\ricfr\\Repos\\agent"))
			.toBe("--C--Users-ricfr-Repos-agent--");
	});

	it("handles simple linux path", () => {
		expect(pathToBucketName("/home/ricfr/project"))
			.toBe("--home-ricfr-project--");
	});

	it("matches pi getDefaultSessionDir encoding exactly", () => {
		const cwd = "/mnt/c/Users/ricfr/Repos/agent";
		// Replicates pi's own formula from session-manager.js
		const piExpected = "--" + cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
		expect(pathToBucketName(cwd)).toBe(piExpected);
	});

	it("path without leading slash is unchanged apart from wrapping", () => {
		expect(pathToBucketName("relative/path")).toBe("--relative-path--");
	});
});

// ---------------------------------------------------------------------------
// getDirectoryCompletions
// ---------------------------------------------------------------------------

describe("getDirectoryCompletions", () => {
	beforeEach(() => vi.resetAllMocks());

	function makeDirents(entries: Array<{ name: string; isDir: boolean }>) {
		return entries.map(({ name, isDir }) => ({
			name,
			isDirectory: () => isDir,
			isFile: () => !isDir,
		}));
	}

	it("returns directories matching prefix", () => {
		vi.mocked(fs.readdirSync as MockedFunction<any>).mockReturnValue(
			makeDirents([
				{ name: "agent", isDir: true },
				{ name: "dotfiles", isDir: true },
				{ name: "README.md", isDir: false },
			])
		);
		const results = getDirectoryCompletions("ag", "/home/ricfr/repos");
		expect(results).toHaveLength(1);
		expect(results[0].label).toBe("agent");
		expect(results[0].value).toContain("agent");
	});

	it("returns all directories when prefix is empty", () => {
		vi.mocked(fs.readdirSync as MockedFunction<any>).mockReturnValue(
			makeDirents([
				{ name: "agent", isDir: true },
				{ name: "dotfiles", isDir: true },
				{ name: "file.txt", isDir: false },
			])
		);
		const results = getDirectoryCompletions("", "/home/ricfr/repos");
		expect(results).toHaveLength(2);
	});

	it("hides hidden dirs when prefix does not start with dot", () => {
		vi.mocked(fs.readdirSync as MockedFunction<any>).mockReturnValue(
			makeDirents([
				{ name: ".git", isDir: true },
				{ name: "src", isDir: true },
			])
		);
		const results = getDirectoryCompletions("", "/some/dir");
		expect(results).toHaveLength(1);
		expect(results[0].label).toBe("src");
	});

	it("shows hidden dirs when prefix starts with dot (e.g. '.g')", () => {
		vi.mocked(fs.readdirSync as MockedFunction<any>).mockReturnValue(
			makeDirents([
				{ name: ".git", isDir: true },
				{ name: "src", isDir: true },
			])
		);
		// Prefix '.g' → filterStr='.g', which starts with '.', so hidden dirs are shown
		const results = getDirectoryCompletions(".g", "/some/dir");
		expect(results).toHaveLength(1);
		expect(results[0].label).toBe(".git");
	});

	it("returns empty array when readdirSync throws", () => {
		vi.mocked(fs.readdirSync as MockedFunction<any>).mockImplementation(() => {
			throw new Error("ENOENT");
		});
		expect(getDirectoryCompletions("anything", "/no/such/dir")).toEqual([]);
	});

	it("is case-insensitive for prefix matching", () => {
		vi.mocked(fs.readdirSync as MockedFunction<any>).mockReturnValue(
			makeDirents([{ name: "Agent", isDir: true }])
		);
		const results = getDirectoryCompletions("ag", "/some/dir");
		expect(results).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// session_start handler
// ---------------------------------------------------------------------------

describe("session_start handler", () => {
	it("sets cwd-mismatch status when cwds differ", () => {
		const pi = makeMockPi();
		handoffFactory(pi);
		const ctx = { cwd: "/some/other/path", ui: { notify: vi.fn(), setStatus: vi.fn() } };
		pi.sessionStartHandler?.({}, ctx);
		expect(ctx.ui.setStatus).toHaveBeenCalledWith(
			"cwd-mismatch",
			expect.stringContaining("/some/other/path")
		);
	});

	it("clears cwd-mismatch status when cwds match", () => {
		const pi = makeMockPi();
		handoffFactory(pi);
		const ctx = { cwd: process.cwd(), ui: { notify: vi.fn(), setStatus: vi.fn() } };
		pi.sessionStartHandler?.({}, ctx);
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("cwd-mismatch", undefined);
	});
});

// ---------------------------------------------------------------------------
// handoff command handler
// ---------------------------------------------------------------------------

describe("handoff handler", () => {
	let pi: ReturnType<typeof makeMockPi>;
	let ctx: ReturnType<typeof makeMockCtx>;

	beforeEach(() => {
		vi.resetAllMocks();

		pi = makeMockPi();
		handoffFactory(pi);

		ctx = makeMockCtx();

		// Default fs behaviour: paths exist, realpathSync is identity (no symlink)
		vi.mocked(fs.existsSync as MockedFunction<any>).mockReturnValue(true);
		vi.mocked(fs.realpathSync as MockedFunction<any>).mockImplementation((p: string) => p);
		vi.mocked(fs.readFileSync as MockedFunction<any>).mockReturnValue(makeSessionContent());
		vi.mocked(fs.mkdirSync as MockedFunction<any>).mockReturnValue(undefined);
		vi.mocked(fs.writeFileSync as MockedFunction<any>).mockReturnValue(undefined);
		vi.mocked(fs.unlinkSync as MockedFunction<any>).mockReturnValue(undefined);
	});

	it("errors with no argument", async () => {
		await pi.handoffHandler("  ", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Usage"), "error");
		expect(fs.writeFileSync).not.toHaveBeenCalled();
	});

	it("errors when no session file (ephemeral mode)", async () => {
		ctx.sessionManager.getSessionFile.mockReturnValue(null);
		await pi.handoffHandler("/some/path", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("ephemeral"), "error");
	});

	it("errors when target directory does not exist", async () => {
		vi.mocked(fs.existsSync as MockedFunction<any>).mockReturnValue(false);
		await pi.handoffHandler("/nonexistent", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("not found"), "error");
	});

	it("errors when target is same as current cwd", async () => {
		vi.mocked(fs.realpathSync as MockedFunction<any>).mockReturnValue(ctx.cwd);
		await pi.handoffHandler(ctx.cwd, ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("already"), "error");
	});

	it("writes session to bucket derived from real path (non-symlink)", async () => {
		const target = "/home/ricfr/repos/agent";
		vi.mocked(fs.realpathSync as MockedFunction<any>).mockReturnValue(target);

		await pi.handoffHandler(target, ctx);

		const expectedBucket = "--home-ricfr-repos-agent--";
		expect(fs.mkdirSync).toHaveBeenCalledWith(
			expect.stringContaining(expectedBucket),
			expect.anything()
		);
		expect(fs.writeFileSync).toHaveBeenCalledWith(
			expect.stringContaining(expectedBucket),
			expect.any(String),
			"utf8"
		);
	});

	it("uses real path for bucket when target is a symlink", async () => {
		const symlinkPath = "/home/ricfr/repos/agent";
		const realPath = "/mnt/c/Users/ricfr/Repos/agent";
		vi.mocked(fs.realpathSync as MockedFunction<any>).mockReturnValue(realPath);

		await pi.handoffHandler(symlinkPath, ctx);

		expect(fs.mkdirSync).toHaveBeenCalledWith(
			expect.stringContaining("--mnt-c-Users-ricfr-Repos-agent--"),
			expect.anything()
		);
		expect(fs.writeFileSync).toHaveBeenCalledWith(
			expect.stringContaining("--mnt-c-Users-ricfr-Repos-agent--"),
			expect.any(String),
			"utf8"
		);
	});

	it("falls back to resolved path when realpathSync throws (broken symlink)", async () => {
		const target = "/home/ricfr/repos/agent";
		vi.mocked(fs.realpathSync as MockedFunction<any>).mockImplementation(() => {
			throw new Error("ENOENT");
		});

		await pi.handoffHandler(target, ctx);

		expect(fs.mkdirSync).toHaveBeenCalledWith(
			expect.stringContaining("--home-ricfr-repos-agent--"),
			expect.anything()
		);
	});

	it("written session header has updated cwd", async () => {
		const target = "/home/ricfr/repos/agent";
		vi.mocked(fs.realpathSync as MockedFunction<any>).mockReturnValue(target);

		let written = "";
		vi.mocked(fs.writeFileSync as MockedFunction<any>).mockImplementation((_p: string, data: string) => {
			written = data;
		});

		await pi.handoffHandler(target, ctx);

		const header = JSON.parse(written.split("\n")[0]);
		expect(header.cwd).toBe(target);
	});

	it("written session has a handedoff session_info entry as last line", async () => {
		const target = "/home/ricfr/repos/agent";
		vi.mocked(fs.realpathSync as MockedFunction<any>).mockReturnValue(target);

		let written = "";
		vi.mocked(fs.writeFileSync as MockedFunction<any>).mockImplementation((_p: string, data: string) => {
			written = data;
		});

		await pi.handoffHandler(target, ctx);

		const lines = written.split("\n").filter(Boolean);
		const last = JSON.parse(lines[lines.length - 1]);
		expect(last.type).toBe("session_info");
		expect(last.name).toMatch(/^handedoff:/);
	});

	it("deletes original session file after successful switch", async () => {
		vi.mocked(fs.realpathSync as MockedFunction<any>).mockReturnValue("/home/ricfr/repos/agent");

		await pi.handoffHandler("/home/ricfr/repos/agent", ctx);

		expect(fs.unlinkSync).toHaveBeenCalledWith(SESSION_FILE);
	});

	it("on cancelled handoff: cleans up new file and does not delete original", async () => {
		const target = "/home/ricfr/repos/agent";
		vi.mocked(fs.realpathSync as MockedFunction<any>).mockReturnValue(target);
		ctx.switchSession.mockResolvedValue({ cancelled: true });

		await pi.handoffHandler(target, ctx);

		// New file in target bucket should be cleaned up
		const calls = vi.mocked(fs.unlinkSync as MockedFunction<any>).mock.calls.map((c: any[]) => c[0] as string);
		expect(calls.some((p: string) => p.includes("--home-ricfr-repos-agent--"))).toBe(true);
		// Original must be preserved
		expect(calls).not.toContain(SESSION_FILE);
		expect(ctx.ui.notify).toHaveBeenCalledWith("Handoff cancelled", "info");
	});

	it("calls switchSession with the new session file path", async () => {
		const target = "/home/ricfr/repos/agent";
		vi.mocked(fs.realpathSync as MockedFunction<any>).mockReturnValue(target);

		await pi.handoffHandler(target, ctx);

		expect(ctx.switchSession).toHaveBeenCalledWith(
			expect.stringContaining("--home-ricfr-repos-agent--"),
			expect.objectContaining({ withSession: expect.any(Function) })
		);
	});
});

// ---------------------------------------------------------------------------
// getArgumentCompletions — uses sessionCwd updated by session_start
// ---------------------------------------------------------------------------

describe("getArgumentCompletions", () => {
	beforeEach(() => vi.resetAllMocks());

	it("uses sessionCwd from session_start, not process.cwd()", () => {
		const pi = makeMockPi();
		handoffFactory(pi);

		// Simulate session_start setting a different cwd
		const sessionCwd = "/handed/off/project";
		pi.sessionStartHandler?.({}, { cwd: sessionCwd, ui: { notify: vi.fn(), setStatus: vi.fn() } });

		vi.mocked(fs.readdirSync as MockedFunction<any>).mockReturnValue([]);
		pi.completionsHandler?.("sub");

		// readdirSync should have been called with a path derived from sessionCwd
		const callArg = vi.mocked(fs.readdirSync as MockedFunction<any>).mock.calls[0]?.[0] as string;
		expect(callArg).toContain("/handed/off/project");
		expect(callArg).not.toContain(process.cwd());
	});
});
