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
      // Per-glob thresholds: the engine rules core carries a real gate from
      // issue #13's suite onward. It measures 100% on all four metrics today.
      // `functions` is pinned at exactly 100 on purpose — a wholly untested
      // new function must fail the gate — while statements, branches and
      // lines sit just below the measured value as buffer against incidental
      // churn; issue #14 raises those three as resolveTurn and the projection
      // land. The global numbers stay at 0
      // because `packages/server` and `packages/web` are still scaffolds —
      // a single global figure would be dominated by the engine and would
      // wave their 0% through; issues #18/#19 add their own glob entries.
      thresholds: {
        "packages/engine/src/**": {
          statements: 98,
          branches: 95,
          functions: 100,
          lines: 98,
        },
        lines: 0,
        functions: 0,
        branches: 0,
        statements: 0,
      },
    },
  },
});
