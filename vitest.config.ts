import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["packages/*/tests/**/*.test.ts", "pit/tests/**/*.test.ts", "pit/src/**/*.test.ts"],
		root: ".",
		testTimeout: 15000,
	},
});
