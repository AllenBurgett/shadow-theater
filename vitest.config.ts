import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      reportsDirectory: "./coverage",
      // v4 removed `coverage.all`: without an explicit include, untested
      // files silently report 100% (research R4).
      include: ["packages/*/src/**/*.{ts,tsx}"],
      exclude: [
        "packages/*/src/**/*.test.{ts,tsx}",
        "packages/*/src/**/*.d.ts",
        "packages/web/src/main.tsx",
      ],
      // Thresholds stay at 0 while the packages are scaffolds; the rules
      // core (issues #13/#14) raises them alongside its own suite.
      thresholds: {
        lines: 0,
        functions: 0,
        branches: 0,
        statements: 0,
      },
    },
  },
});
