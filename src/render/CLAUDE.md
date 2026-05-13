# src/render/ — SVG generation and rasterization

The render pipeline: actions call a `renderXxx(...)` function in `svg.ts` that returns an SVG **string**, then pass it to `toImageUri(svg)` in `rasterize.ts` which returns a `data:image/png;base64,...` URI suitable for `keyAction.setImage()`.

```
action ── renderQuotaMeter({...}) ──▶ "<svg>...</svg>"
                                            │
                                            ▼
                              toImageUri(svg) ──▶ "data:image/png;base64,..."
                                            │
                                            ▼
                              keyAction.setImage(uri)
```

## Why pre-rasterize in the plugin

Stream Deck can rasterize SVG itself, but it's noticeably slower — especially when the user is fiddling PI settings and we re-render multiple times per second. resvg-wasm in the Node host with an LRU cache is materially faster (`rasterize.ts:38-43`).

## The cache

`toImageUri` caches by **exact SVG string** with an LRU cap of 256 entries (`rasterize.ts:32-33,57-61`). Practical implications:

- Toggling 5h ⇄ 7d on a quota meter is free after the first render of each.
- Tiny string changes bust the cache: an embedded timestamp, random nonce, or floating-point noise will defeat it. Round / quantize values you serialize into the SVG.
- Don't pre-warm the cache speculatively — a cold key is rendered in <10ms anyway, and pre-warming wastes CPU on Stream-Deck-less app launches.

## Font handling (the gotcha)

resvg-wasm runs in a sandbox that **cannot read system font files**. Without an explicit font, every `<text>` element renders as nothing — text-only tiles silently come up as blank dark squares.

`init()` (`rasterize.ts`) reads a sans-serif from the host filesystem and hands the buffer to every `Resvg` instance via `font.fontBuffers`. Platform-aware candidate list:

- macOS: `/System/Library/Fonts/Helvetica.ttc` (Helvetica)
- Windows: `C:\Windows\Fonts\arial.ttf` (Arial), falling back to `segoeui.ttf`

The SVG markup uses `font-family: "Helvetica, Arial, sans-serif"` so the same templates render reasonably on either platform — resvg picks whichever family the loaded font advertises.

If you want to add another typeface:
1. Read it once at init, stash the bytes in a module-level variable.
2. Pass it in the same `fontBuffers` array.
3. Use the corresponding `font-family` in the SVG markup.

## Theme (`theme.ts`)

Single source of truth for colors and the 144px size constant. The `quotaColor(utilization)` function is the canonical green/amber/red ramp (green <60%, amber 60–85%, red ≥85%). Reuse it for any meter-style visual; don't redefine thresholds inline.

## SVG conventions

- Target size is **144 × 144** (`rasterize.ts:7`). Stream Deck downscales to the actual key size.
- Keep markup compact — every byte goes through wasm and is cached by content. Strip comments and excess whitespace.
- Use `"Helvetica, Arial, sans-serif"` in `font-family` (the existing convention). resvg's shaping is unforgiving with unloaded families — keep it to the platform set we actually load.
- The background is transparent (`background: "rgba(0,0,0,0)"` at `rasterize.ts:50`); fill the canvas explicitly inside the SVG if you want a solid color.
