# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**siestadeck** — an Elgato Stream Deck plugin that turns physical Stream Deck keys into a live readout of Claude Code quota (5h / 7d / per-model Fable weekly Max windows), spend, active model, and a one-press multi-account switcher. Reads from local `~/.claude/` telemetry plus Anthropic's undocumented OAuth `/api/oauth/usage` endpoint, with intelligent rate-limiting. Targets macOS (validated) and Windows (CI builds; not yet validated end-to-end on a physical Windows + Stream Deck setup).

Stack: TypeScript (strict, ES2022, `Bundler` module resolution), Rollup bundle, `@elgato/streamdeck` SDK v2, `@resvg/resvg-wasm` for SVG-to-PNG. Node ≥20.

## Commands

```bash
npm run icons      # rasterize assets/icons/*.svg → io.github.aguilarguisado.siestadeck.sdPlugin/imgs/*.png
npm run build      # prebuild runs icons; rollup bundles src/plugin.ts → bin/plugin.js
npm run watch      # rebuild + auto-restart plugin in Stream Deck on every change
npm run validate   # validate manifest against the Stream Deck SDK
npm run link       # symlink plugin into Stream Deck's plugin directory (one-time setup)
npm run restart    # restart the plugin in the running Stream Deck app
npm run test       # vitest run (no coverage)
npm run coverage   # vitest run --coverage (gated at 80% per vitest.config.ts)
npm run pack       # create a .streamDeckPlugin distributable
```

Correctness gates: type-checking via `rollup -c` (strict TS) and `npm run coverage` (Vitest). CI runs both on macOS and Windows. The coverage gate excludes Stream Deck SDK glue (action wrapper classes) and the heavy service classes (accounts/quota/activeSession) — their pure cores live in `*Policy.ts`/`draw/*.ts` siblings and are tested at near-100%. Don't lower the threshold without also widening the well-tested surface.

`npm run watch` is the development happy-path: every save rebuilds and runs `streamdeck restart io.github.aguilarguisado.siestadeck`, so the plugin reloads in Stream Deck within ~1 second. No manual reload needed.

## Architecture (the big picture)

```
~/.claude/projects/.../*.jsonl              ─┐
Anthropic OAuth /api/oauth/usage             │
Keychain (mac) / DPAPI (Windows) credentials ├─► Services (EventEmitter snapshots)
accountsRegistryJson (paths.ts)             ─┘       │
                                                     ▼
                                  Actions subscribe via .on("snapshot", ...)
                                                     │
                                                     ▼
                                  src/render/svg.ts → SVG string
                                                     │
                                                     ▼
                                  src/render/rasterize.ts → PNG data URI (LRU cached)
                                                     │
                                                     ▼
                                  keyAction.setImage(uri) → Stream Deck button
```

**The single most important rule:** *actions are stateless renderers*. They never poll, never fetch, never read files directly. They subscribe to a service snapshot and re-render. All polling, file watching, network calls, rate-limiting, and caching live in `src/services/`.

`src/plugin.ts` is the entry point: registers the 5 action classes, eagerly starts `accountsService` + `quotaRegistry`, leaves `activeSessionService` lazy (it `acquire()`s on first key appear), and wires device connect/disconnect/wake events to suspend or re-arm work.

## Where to look when working in...

- **`src/actions/`** — see [src/actions/CLAUDE.md](src/actions/CLAUDE.md). Stream Deck action classes, lifecycle events, settings, the lazy-service `acquire`/`release` reference-counting contract.
- **`src/services/`** — see [src/services/CLAUDE.md](src/services/CLAUDE.md). Snapshot model, the three data sources, quota refresh policy (5s coalesce, 1→10min 429 backoff, idle gating), atomic account swap.
- **`src/render/`** — see [src/render/CLAUDE.md](src/render/CLAUDE.md). SVG generation, resvg-wasm pipeline, font handling, LRU cache, theme tokens.
- **`io.github.aguilarguisado.siestadeck.sdPlugin/`** — see [io.github.aguilarguisado.siestadeck.sdPlugin/CLAUDE.md](io.github.aguilarguisado.siestadeck.sdPlugin/CLAUDE.md). Manifest, Property Inspector HTML, datasource event protocol.

## Cross-cutting conventions

- **Platform-aware, not OS-locked.** macOS and Windows are both targets. Platform branches live in `src/services/platform.ts` (`isMac`/`isWindows`) and are funneled through `src/services/paths.ts` (filesystem locations), `src/services/credentialStore.ts` (Keychain on mac, DPAPI on Windows), and `src/services/terminal.ts` (osascript on mac, `cmd /k` on Windows). Never hardcode `os.homedir()/.claude/...` paths — use `paths.ts`. Linux has no Stream Deck app, so don't add a Linux branch.
- **`Bundler` module resolution + `.js` import suffixes.** All intra-repo imports use `.js` extensions even though sources are `.ts` (see `src/plugin.ts:3-13`). Don't strip them — the suffixes keep the source portable.
- **EventEmitter singletons.** Services export a default singleton (`accountsService`, `quotaRegistry`, `activeSessionService`). Never `new` them in actions.
- **Snapshot fingerprinting** is used to suppress no-op re-emits (`activeSession.ts:202-204`). Mirror that pattern if you add a new aggregating service.
- **`unref()` every `setTimeout`/`setInterval`** that should not keep the Node event loop alive (see `quota.ts:249,252`, `activeSession.ts:91-92`). The plugin host shuts down cleanly only if no live timers remain.
- **Sans-serif loaded from disk** and handed to resvg-wasm explicitly (`render/rasterize.ts`). The wasm sandbox cannot read system fonts on its own — text-only tiles render blank without this. On macOS we load `Helvetica.ttc`; on Windows `arial.ttf` (falling back to Segoe UI).
