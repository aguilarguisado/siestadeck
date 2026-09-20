import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

const isWatching = !!process.env.ROLLUP_WATCH;

/** @type {import('rollup').RollupOptions} */
const config = {
  input: "src/main.ts",
  // CommonJS, not ESM. Electron supports an ESM main process, but it loads the
  // entry point asynchronously, which puts listener registration in a race with
  // events that fire early in startup. CJS is the trodden path and costs us
  // nothing: @siesta/core uses no `import.meta`, no top-level await and no
  // `require`, so it compiles down either way.
  output: {
    file: "dist/main.cjs",
    format: "cjs",
    sourcemap: isWatching,
  },
  // `electron` is injected by the runtime, never bundled — resolving it here
  // would pull in the npm package's install shim (a path string), not the API.
  external: ["electron"],
  plugins: [
    typescript({
      sourceMap: isWatching,
      mapRoot: isWatching ? "./" : undefined,
      // tsconfig's `rootDir` is the repo root, which widens this plugin's
      // internal file filter to cover packages/core/src/** — that filter is
      // also what de-externalizes workspace `.ts` reached through the
      // node_modules symlink. It must not reach into node_modules itself, or
      // every dependency's .d.ts gets pulled in as a local source file.
      exclude: ["**/node_modules/**", "**/*.test.ts"],
    }),
    nodeResolve({ browser: false, exportConditions: ["node"], preferBuiltins: true }),
    commonjs(),
    // No terser, unlike the Stream Deck plugin. There is no distributable to
    // shrink yet, and an app with no devtools debugs entirely through terminal
    // stack traces — minifying them away costs more than the bytes save.
  ],
};

export default config;
