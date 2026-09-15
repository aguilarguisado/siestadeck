import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const coreEntry = fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // `@siesta/core` is consumed as TypeScript SOURCE, never as a built dist.
      // Pinning it here makes resolution independent of the npm-workspaces
      // symlink and keeps tsc, rollup and vitest pointed at one literal file.
      { find: /^@siesta\/core$/, replacement: coreEntry },
      // Source files use NodeNext-style `.js` import suffixes that resolve to
      // sibling `.ts` files. Strip the suffix so Vitest's resolver lands on the
      // TypeScript sources. Limited to relative imports so node_modules are
      // untouched.
      { find: /^(\.{1,2}\/.+)\.js$/, replacement: "$1" },
    ],
  },
  test: {
    environment: "node",

    // No `test.include` at this level. Vite's mergeConfig CONCATENATES arrays,
    // and both projects below use `extends: true` (which is what makes the
    // aliases above visible to them), so a root include would be appended to
    // every project's own list and each project would run every test.
    //
    // `name` is mandatory here: without it both projects derive the same name
    // from the root package.json and Vitest rejects the duplicate.
    projects: [
      {
        extends: true,
        test: { name: "core", include: ["packages/core/src/**/*.test.ts"] },
      },
      {
        extends: true,
        test: { name: "streamdeck", include: ["apps/streamdeck/src/**/*.test.ts"] },
      },
    ],

    // `coverage` is a root-only option in Vitest 4, so this is one aggregated
    // report and one threshold across both projects.
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      // Must name both packages explicitly. A bare "src/**/*.ts" would still
      // appear to work — per-file reports match by substring — but the
      // untested-file sweep globs from the repo root, so every zero-coverage
      // file would silently drop out of the report and the percentage would
      // RISE while real coverage fell.
      include: ["apps/streamdeck/src/**/*.ts", "packages/core/src/**/*.ts"],
      // Excluded from coverage gates:
      // - plugin.ts: top-level bootstrap, exercised at runtime by Stream Deck.
      // - rasterize.ts: wasm + native font I/O; needs an integration test.
      // - Action class files (actions/*.ts, not the draw/ subdir): SDK glue.
      //   The pure SVG composition lives in actions/draw/ and is covered at
      //   100%. The wrapper classes can only be exercised against a live
      //   Stream Deck host.
      // - Core service classes that wrap I/O (accounts/activeSession/quota):
      //   pure cores extracted into *Policy modules are covered; the wrapper
      //   classes need an integration harness that hasn't been built yet.
      // - index.ts: the @siesta/core barrel, pure re-exports with no logic.
      exclude: [
        "apps/streamdeck/src/plugin.ts",
        "apps/streamdeck/src/render/rasterize.ts",
        "apps/streamdeck/src/actions/quotaMeter.ts",
        "apps/streamdeck/src/actions/extraUsage.ts",
        "apps/streamdeck/src/actions/activeModel.ts",
        "apps/streamdeck/src/actions/switchAccount.ts",
        "apps/streamdeck/src/actions/loginLogout.ts",
        "packages/core/src/accounts.ts",
        "packages/core/src/activeSession.ts",
        "packages/core/src/quota.ts",
        "packages/core/src/index.ts",
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
