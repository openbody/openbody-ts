import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["test/**", "scripts/**"],
      reporter: ["text", "html"],
      thresholds: {
        // The ported suite achieves ~97% lines / ~94% statements / ~81% branches
        // on src/ — thresholds sit a small margin under that, so CI stays green
        // but a real coverage regression still fails the build.
        lines: 92,
        statements: 88,
        functions: 92,
        branches: 75,
      },
    },
  },
});
