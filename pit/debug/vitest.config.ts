import { defineConfig } from "vitest/config";

// Standalone config for the SBPL research probe.
// Runs pit/debug/sbpl-probe.test.ts outside the production test suite.
// Usage: npx vitest run --config pit/debug/vitest.config.ts --reporter verbose
export default defineConfig({
  test: {
    include: ["pit/debug/**/*.test.ts"],
    root: ".",
    testTimeout: 30000,
  },
});
