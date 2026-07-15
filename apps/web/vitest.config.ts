import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
    env: {
      // Unit tests exercise the built-in extractors; never spawn the
      // Docling sidecar (a Python process per PDF) from a test.
      MYWIKI_DISABLE_DOCLING: "1",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
