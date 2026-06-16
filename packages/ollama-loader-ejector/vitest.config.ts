import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		name: "ollama-loader-ejector",
		include: ["tests/**/*.test.ts"],
	},
});
