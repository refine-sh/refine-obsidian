import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    restoreMocks: true,
    setupFiles: ["./test/setup/obsidian-dom.ts"],
  },
});
