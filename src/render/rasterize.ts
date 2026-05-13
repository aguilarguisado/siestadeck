import { initWasm, Resvg } from "@resvg/resvg-wasm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMac, isWindows } from "../services/platform.js";

const WASM_FILENAME = "resvg.wasm";
const SIZE = 144;

// resvg-wasm runs in a sandbox that cannot read system fonts. Without an
// explicit font, every <text> element renders blank. We load a sans-serif
// from the host filesystem and hand the bytes to every Resvg instance.
const FONT_CANDIDATES: ReadonlyArray<{ path: string; family: string }> = isMac
  ? [{ path: "/System/Library/Fonts/Helvetica.ttc", family: "Helvetica" }]
  : isWindows
    ? [
        { path: "C:\\Windows\\Fonts\\arial.ttf", family: "Arial" },
        { path: "C:\\Windows\\Fonts\\segoeui.ttf", family: "Segoe UI" },
      ]
    : [];

let initPromise: Promise<void> | null = null;
let fontBytes: Uint8Array | null = null;
let fontFamily: string | null = null;

export function init(): Promise<void> {
  if (initPromise) return initPromise;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const wasmPath = path.join(here, WASM_FILENAME);
  const buf = fs.readFileSync(wasmPath);
  initPromise = initWasm(buf).then(() => {
    for (const candidate of FONT_CANDIDATES) {
      try {
        fontBytes = fs.readFileSync(candidate.path);
        fontFamily = candidate.family;
        break;
      } catch {
        // try next candidate
      }
    }
    // If no candidate matched the host falls through to resvg's built-in
    // sans-serif default — text-only tiles may render blank.
  });
  return initPromise;
}

const cache = new Map<string, string>();
const MAX_CACHE = 256;

/**
 * Rasterizes an SVG string to a base64 PNG data URI. Caches by exact SVG
 * string — repeat renders (e.g. user toggling 5h/7d back and forth) are
 * served from memory with no work.
 *
 * Pre-rasterizing in the plugin is materially faster than letting Stream
 * Deck rasterize SVG on its side, especially when the PI is wiggling
 * settings quickly.
 */
export async function toImageUri(svg: string): Promise<string> {
  const hit = cache.get(svg);
  if (hit) return hit;
  await init();
  const r = new Resvg(svg, {
    fitTo: { mode: "width", value: SIZE },
    background: "rgba(0,0,0,0)",
    font: fontBytes && fontFamily
      ? { fontBuffers: [fontBytes], defaultFontFamily: fontFamily }
      : { loadSystemFonts: false },
  });
  const png = r.render().asPng();
  const uri = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
  if (cache.size >= MAX_CACHE) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(svg, uri);
  return uri;
}
