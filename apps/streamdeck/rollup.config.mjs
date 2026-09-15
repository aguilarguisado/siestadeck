import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import url from "node:url";

const require = createRequire(import.meta.url);
const isWatching = !!process.env.ROLLUP_WATCH;
const sdPlugin = "io.github.aguilarguisado.siestadeck.sdPlugin";

/** @type {import('rollup').RollupOptions} */
const config = {
  input: "src/plugin.ts",
  output: {
    file: `${sdPlugin}/bin/plugin.js`,
    sourcemap: isWatching,
    sourcemapPathTransform: (relativeSourcePath, sourcemapPath) => {
      return url.pathToFileURL(path.resolve(path.dirname(sourcemapPath), relativeSourcePath)).href;
    },
  },
  plugins: [
    {
      name: "watch-externals",
      buildStart: function () {
        this.addWatchFile(`${sdPlugin}/manifest.json`);
      },
    },
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
    !isWatching && terser(),
    {
      name: "emit-module-package-file",
      generateBundle() {
        this.emitFile({ fileName: "package.json", source: `{ "type": "module" }`, type: "asset" });
      },
    },
    {
      name: "copy-resvg-wasm",
      generateBundle() {
        // Resolved, not cwd-relative: npm workspaces hoist @resvg/resvg-wasm to
        // the repo-root node_modules, where a relative "node_modules/..." path
        // from this workspace would not find it.
        const wasm = fs.readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm"));
        this.emitFile({ fileName: "resvg.wasm", source: wasm, type: "asset" });
      },
    },
  ],
};

export default config;
