import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "pit",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
