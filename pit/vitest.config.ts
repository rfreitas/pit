import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "pit",
    include: ["tests/**/*.test.ts"],
  },
});
