import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["packages/*/tests/**/*.test.ts", "pit/tests/**/*.test.ts", "pit/src/**/*.test.ts"],
		root: ".",
		// pit e2e tests spawn pit as a subprocess; @effect/platform-node adds
		// ~300ms import overhead per invocation. Tests that run pit twice
		// (e.g. worktree-reuse, -p stdout) need headroom above the 5s default.
		testTimeout: 15000,
	},
});
