#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = readFileSync(join(root, "package.json"), "utf8");
const manifest = readFileSync(
  join(root, "io.github.aguilarguisado.siestadeck.sdPlugin", "manifest.json"),
  "utf8",
);

const problems = [];

const tokenRe = /<TODO_(OWNER|REPO|HANDLE)>/g;
const pkgTokens = pkg.match(tokenRe);
if (pkgTokens) {
  problems.push(
    `package.json still contains placeholders: ${[...new Set(pkgTokens)].join(", ")}`,
  );
}
const manifestTokens = manifest.match(tokenRe);
if (manifestTokens) {
  problems.push(
    `manifest.json still contains placeholders: ${[...new Set(manifestTokens)].join(", ")}`,
  );
}

if (/"UUID":\s*"com\.juan\./.test(manifest)) {
  problems.push(
    'manifest.json UUID still uses the placeholder "com.juan.*" namespace. Rename to `io.github.<handle>.siestadeck` (or a domain you own) before publishing.',
  );
}

if (problems.length > 0) {
  console.error("\n  Release readiness check failed:\n");
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    "\n  These placeholders must be replaced before packing the .streamDeckPlugin.\n",
  );
  process.exit(1);
}

console.log("Release readiness check passed.");
