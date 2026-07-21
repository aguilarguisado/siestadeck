import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Source files use NodeNext-style `.js` import suffixes that resolve to
    // sibling `.ts` files. Strip the suffix so Vitest's resolver lands on the
    // TypeScript sources. Limited to relative imports so node_modules are
    // untouched.
    alias: [
      { find: /^(\.{1,2}\/.+)\.js$/, replacement: "$1" },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["src/**/*.ts"],
      // Excluded from coverage gates:
      // - plugin.ts: top-level bootstrap, exercised at runtime by Stream Deck.
      // - rasterize.ts: wasm + native font I/O; needs an integration test.
      // - Action class files (src/actions/*.ts, not the draw/ subdir): SDK
      //   glue. The pure SVG composition lives in src/actions/draw/ and is
      //   covered at 100%. The wrapper classes can only be exercised against
      //   a live Stream Deck host.
      // - Service classes that wrap I/O (accounts/quota/activeSession): pure
      //   cores extracted into *Aggregate/*Policy/*Parse modules are covered;
      //   the wrapper classes need an integration harness that hasn't been
      //   built yet.
      exclude: [
        "src/plugin.ts",
        "src/render/rasterize.ts",
        "src/actions/quotaMeter.ts",
        "src/actions/extraUsage.ts",
        "src/actions/activeModel.ts",
        "src/actions/switchAccount.ts",
        "src/actions/loginLogout.ts",
        "src/services/accounts.ts",
        "src/services/activeSession.ts",
        "src/services/quota.ts",
        "**/*.test.ts",
        "**/__snapshots__/**",
        "**/*.d.ts",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
