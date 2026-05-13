// Rasterizes the SVG icons in assets/icons/ to the PNG paths that the
// Stream Deck manifest expects. Adds a colored backdrop for keys so the
// glyph reads correctly on the actual Stream Deck hardware.

import fs from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";

const ROOT = "io.github.aguilarguisado.siestadeck.sdPlugin/imgs";
const ASSETS = "assets/icons";

const ACTIONS = [
  "quota-meter",
  "extra-usage",
  "active-model",
  "switch-account",
  "login-logout",
];

// Property Inspector sidebar icons want light glyphs on a transparent background
// (Stream Deck app inverts based on its own theme).
function tintedSvg(svg, color) {
  return svg.replace(/currentColor/g, color);
}

function rasterize(svg, size) {
  const r = new Resvg(svg, { fitTo: { mode: "width", value: size }, background: "rgba(0,0,0,0)" });
  return r.render().asPng();
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeSidebarIcon(slug, svg) {
  const dir = path.join(ROOT, "actions", slug);
  ensureDir(dir);
  // Stream Deck draws the action sidebar icon on a dark background, so use white glyphs.
  const tinted = tintedSvg(svg, "#FFFFFF");
  fs.writeFileSync(path.join(dir, "icon.png"), rasterize(tinted, 20));
  fs.writeFileSync(path.join(dir, "icon@2x.png"), rasterize(tinted, 40));
}

function writeKeyImage(slug, svg) {
  const dir = path.join(ROOT, "actions", slug);
  ensureDir(dir);
  // Key images are the default visual for a freshly-dragged action before our
  // SVG renderer kicks in. Show a dark rounded-rect tile with a centered glyph
  // in the brand-on-dark accent (#d0776c — see src/render/theme.ts).
  // Inline-nest the action SVG instead of round-tripping through a temp PNG;
  // resvg-js does not resolve <image href="file://..."> hrefs.
  const tinted = tintedSvg(svg, "#D0776C");
  const innerBody = tinted.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  const compose = (size) => {
    const inset = size * 0.225;
    const innerSize = size * 0.55;
    const wrapped = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <rect width="${size}" height="${size}" rx="${Math.round(size * 0.11)}" fill="#0F1115"/>
      <svg x="${inset}" y="${inset}" width="${innerSize}" height="${innerSize}" viewBox="0 0 24 24">${innerBody}</svg>
    </svg>`;
    return rasterize(wrapped, size);
  };
  fs.writeFileSync(path.join(dir, "key.png"), compose(72));
  fs.writeFileSync(path.join(dir, "key@2x.png"), compose(144));
}

// Action icons + keys
for (const slug of ACTIONS) {
  const svgPath = path.join(ASSETS, `${slug}.svg`);
  if (!fs.existsSync(svgPath)) {
    console.warn(`  skip ${slug}: no SVG at ${svgPath}`);
    continue;
  }
  const svg = fs.readFileSync(svgPath, "utf8");
  writeSidebarIcon(slug, svg);
  writeKeyImage(slug, svg);
}

// Plugin category + marketplace icons
{
  const dir = path.join(ROOT, "plugin");
  ensureDir(dir);

  const cat = fs.readFileSync(path.join(ASSETS, "category.svg"), "utf8");
  const catTinted = tintedSvg(cat, "#FFFFFF");
  fs.writeFileSync(path.join(dir, "category-icon.png"), rasterize(catTinted, 28));
  fs.writeFileSync(path.join(dir, "category-icon@2x.png"), rasterize(catTinted, 56));

  const mkt = fs.readFileSync(path.join(ASSETS, "marketplace.svg"), "utf8");
  fs.writeFileSync(path.join(dir, "marketplace.png"), rasterize(mkt, 256));
  fs.writeFileSync(path.join(dir, "marketplace@2x.png"), rasterize(mkt, 512));
}

console.log(`built icons for ${ACTIONS.length} actions + plugin assets`);
