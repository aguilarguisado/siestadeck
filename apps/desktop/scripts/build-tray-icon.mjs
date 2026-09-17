// Rasterizes assets/tray.svg to the template PNGs the macOS menu bar wants.
// Mirrors apps/streamdeck/scripts/build-icons.mjs, including the currentColor
// tint trick, at the one size a status item uses.
//
// "Template" is not decoration: macOS recolors a template image itself to match
// the menu bar (light, dark, and inverted while the menu is open), which is why
// the glyph must be pure black plus alpha and why the tray title carries no
// color of its own.

import fs from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";

const OUT = "imgs";
const SRC = path.join("assets", "tray.svg");

// A status item's content area is 22pt tall; 16pt of glyph leaves the padding
// macOS expects on either side. The @2x variant is picked up automatically by
// nativeImage.createFromPath on a Retina display.
const SIZES = [
  { file: "trayTemplate.png", size: 16 },
  { file: "trayTemplate@2x.png", size: 32 },
];

function rasterize(svg, size) {
  const r = new Resvg(svg, { fitTo: { mode: "width", value: size }, background: "rgba(0,0,0,0)" });
  return r.render().asPng();
}

const svg = fs.readFileSync(SRC, "utf8").replace(/currentColor/g, "#000000");

fs.mkdirSync(OUT, { recursive: true });
for (const { file, size } of SIZES) {
  fs.writeFileSync(path.join(OUT, file), rasterize(svg, size));
}

console.log(`built tray template icon (${SIZES.map((s) => `${s.size}px`).join(", ")})`);
