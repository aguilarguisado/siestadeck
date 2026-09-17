# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**siesta** — a monorepo whose apps turn Claude Code's local telemetry into a live readout of quota (5h / 7d / per-model Fable weekly Max windows), spend, active model, and a one-press multi-account switcher. Reads from local `~/.claude/` telemetry plus Anthropic's undocumented OAuth `/api/oauth/usage` endpoint, with intelligent rate-limiting. Targets macOS (validated) and Windows (CI builds; not yet validated end-to-end on a physical Windows + Stream Deck setup).

```
packages/core/       @siesta/core — everything that isn't UI
apps/streamdeck/     @siesta/streamdeck — the Elgato Stream Deck plugin (shipping)
apps/desktop/        @siesta/desktop — the macOS menu bar app (macOS only; not packaged yet)
```

`apps/desktop` is the second app the core extraction was done for, and the reason the cross-process work in `packages/core` exists: both apps share `~/.config/siestadeck/accounts.json`, the credential stashes and the Anthropic rate limit. It is an Electron **main-process-only** app driving a native `NSMenu` — no renderer, no BrowserWindow, no IPC. A browser-only version is not possible — the product reads `~/.claude/projects/*.jsonl`, the macOS Keychain / Windows DPAPI, and shells out to a terminal for OAuth login, all of which need a Node runtime.

Stack: TypeScript (strict, ES2022, `Bundler` module resolution), npm workspaces, Rollup bundle, `@elgato/streamdeck` SDK v2, `@resvg/resvg-wasm` for SVG-to-PNG. Node ≥20.

## Commands

All of these run from the repo root. The unprefixed build/plugin ones delegate to the `@siesta/streamdeck` workspace; `npm run build` still means "the plugin".

```bash
npm run icons          # rasterize apps/streamdeck/assets/icons/*.svg → .sdPlugin/imgs/*.png
npm run build          # prebuild runs icons; rollup bundles src/plugin.ts → bin/plugin.js
npm run watch          # rebuild + auto-restart plugin in Stream Deck on every change
npm run typecheck      # tsc --noEmit over all three workspaces
npm run validate       # validate manifest against the Stream Deck SDK
npm run link           # symlink plugin into Stream Deck's plugin directory (one-time setup)
npm run restart        # restart the plugin in the running Stream Deck app
npm run test           # vitest run (no coverage) — all workspaces, one run
npm run coverage       # vitest run --coverage (gated at 80% per vitest.config.ts)
npm run pack           # create a .streamDeckPlugin distributable
npm run desktop        # build + launch the macOS menu bar app
npm run build:desktop  # bundle the menu bar app only (macOS-gated in CI)
```

Correctness gates: `npm run coverage` (Vitest, 80%) and `npm run typecheck`. **Note `rollup -c` reports type errors as warnings and still exits 0** — it is not a gate on its own, which is why `typecheck` exists and runs in CI. CI runs both on macOS and Windows.

The coverage gate excludes Stream Deck SDK glue (action wrapper classes), the Electron bootstrap (`apps/desktop/src/main.ts`), and `activeSession` — their pure cores live in `*Policy.ts` / `draw/*.ts` / `menuModel.ts` siblings and are tested at near-100%. Don't lower the threshold without also widening the well-tested surface. The `include` list names all three workspaces explicitly; if you touch it, keep it that way — a bare `src/**/*.ts` silently drops every untested file from the report and makes the percentage *rise* while coverage falls.

`npm run watch` is the development happy-path: every save rebuilds and runs `streamdeck restart io.github.aguilarguisado.siestadeck`, so the plugin reloads in Stream Deck within ~1 second. Core is consumed as TypeScript **source**, not a built `dist/`, precisely so this stays a single-stage build with no `tsc` prepass.

## Architecture (the big picture)

```
~/.claude/projects/.../*.jsonl              ─┐
Anthropic OAuth /api/oauth/usage             │
Keychain (mac) / DPAPI (Windows) credentials ├─► @siesta/core services
accountsRegistryJson (paths.ts)             ─┘   (EventEmitter snapshots)
                                                     │
                                  Views subscribe via .on("snapshot", ...)
                                                     │
                        ┌────────────────────────────┴────────────────────────────┐
                        ▼                                                         ▼
          apps/streamdeck/src/render/svg.ts                      apps/desktop/src/menuModel.ts
                   → SVG string                                        → row descriptors
                        │                                                         │
                        ▼                                                         ▼
       render/rasterize.ts → PNG data URI (LRU)                   Menu.buildFromTemplate
                        │                                                         │
                        ▼                                                         ▼
        keyAction.setImage(uri) → Stream Deck key                 tray.popUpContextMenu → NSMenu
```

**The single most important rule:** *views are stateless renderers*. They never poll, never fetch, never read files directly. They subscribe to a service snapshot and re-render. All polling, file watching, network calls, rate-limiting, and caching live in `packages/core`.

`apps/streamdeck/src/plugin.ts` is the plugin's entry point: binds the core's log sink, registers the 5 action classes, eagerly starts `accountsService` + `quotaRegistry`, leaves `activeSessionService` lazy (it `acquire()`s on first key appear), and wires device connect/disconnect/wake events to suspend or re-arm work.

`apps/desktop/src/main.ts` is the menu bar app's, and does the same job against Electron: binds the log sink, starts the same two services in the same order, re-reads the account registry when the menu is about to open and on wake, and never starts `activeSessionService`. Both hosts run their own singletons — a second app is a second process.

## The core boundary

`@siesta/core` must stay UI-agnostic — that is the whole point of the package, and CI asserts it with a grep for `@elgato|electron` under `packages/core/src`.

- **Logging goes through the seam, never a host SDK.** Core calls `log().warn(...)` from `packages/core/src/log.ts`; the host binds a sink once at startup (`setLogger(streamDeck.logger.createScope("core"))` in `plugin.ts`, a `console` wrapper in `main.ts`). The default sink is a **no-op, not `console`** — the Stream Deck SDK speaks over stdio and a stray `console.log` corrupts that channel. The menu bar app owns its stdio outright, so `console` is fine *there*; the no-op default is what lets both be true. Anything logged before `setLogger` is silently dropped.
- **Core does not decide to interrupt the user.** It emits events; the host decides whether that becomes a notification. `notify()` lives in core as a cross-platform utility but no core service calls it — see the `"swapped"` handler in `plugin.ts`. This is now load-bearing rather than theoretical: the plugin raises that banner and the menu bar app deliberately does not, so one swap with both running produces one notification.
- **The public surface is `packages/core/src/index.ts`.** `exports` has a single `"."` entry, so anything absent from the barrel is unreachable by design. Add to it deliberately, not reflexively.
- **Singletons, not factories.** A second app is a second *process* with its own module registry, so it gets its own singletons for free. `quota.ts` binds the module-level `accountsService` directly.
- **Writes to files we don't own go through `writeJsonAtomic`** (`packages/core/src/atomicJson.ts`) — temp file + `rename(2)`. `~/.claude/settings.json` belongs to Claude Code; use `updateClaudeSettings(fn)` so only the named keys change.

## Where to look when working in...

- **[packages/core/](packages/core/CLAUDE.md)** — snapshot model, the three data sources, quota refresh policy (5s coalesce, 1→10min 429 backoff, idle gating), atomic account swap.
- **[apps/streamdeck/src/actions/](apps/streamdeck/src/actions/CLAUDE.md)** — Stream Deck action classes, lifecycle events, settings, the lazy-service `acquire`/`release` reference-counting contract.
- **[apps/streamdeck/src/render/](apps/streamdeck/src/render/CLAUDE.md)** — SVG generation, resvg-wasm pipeline, font handling, LRU cache, theme tokens.
- **[apps/streamdeck/io.github.aguilarguisado.siestadeck.sdPlugin/](apps/streamdeck/io.github.aguilarguisado.siestadeck.sdPlugin/CLAUDE.md)** — Manifest, Property Inspector HTML, datasource event protocol.
- **[apps/desktop/](apps/desktop/CLAUDE.md)** — the native-menu rule (no renderer, ever), the pure `menuModel.ts` / glue `main.ts` split that holds the coverage gate, and the cross-process `reload()` seam.

## Cross-cutting conventions

- **Platform-aware, not OS-locked — except where an app says otherwise.** macOS and Windows are both targets for `packages/core` and `apps/streamdeck`. Platform branches live in `packages/core/src/platform.ts` (`isMac`/`isWindows`) and are funneled through `paths.ts` (filesystem locations), `credentialStore.ts` (Keychain on mac, DPAPI on Windows), and `terminal.ts` (osascript on mac, `cmd /k` on Windows). Never hardcode `os.homedir()/.claude/...` paths — use `paths.ts`. Linux has no Stream Deck app, so don't add a Linux branch. `apps/desktop` is **macOS-only by design** — don't add platform branches there; its CI build step is gated on `macos-latest`.
- **`Bundler` module resolution + `.js` import suffixes.** All intra-package imports use `.js` extensions even though sources are `.ts`. Don't strip them — the suffixes keep the source portable. Cross-package imports use the bare specifier `@siesta/core`.
- **Both apps' `tsconfig.json` set `rootDir: "../.."` on purpose.** It is what widens `@rollup/plugin-typescript`'s file filter to cover `packages/core/src/**`. Narrow it and Rollup reads raw `.ts` and dies with a parse error that names a core file and explains nothing; delete it and TS 6 errors with TS5011.
- **EventEmitter singletons.** Services export a default singleton (`accountsService`, `quotaRegistry`, `activeSessionService`). Never `new` them in actions.
- **Snapshot fingerprinting** is used to suppress no-op re-emits (`activeSession.ts:202-204`). Mirror that pattern if you add a new aggregating service.
- **`unref()` every `setTimeout`/`setInterval`** that should not keep the Node event loop alive (see `quota.ts:349,352`, `activeSession.ts:91-92`). The plugin host shuts down cleanly only if no live timers remain.
- **Sans-serif loaded from disk** and handed to resvg-wasm explicitly (`render/rasterize.ts`). The wasm sandbox cannot read system fonts on its own — text-only tiles render blank without this. On macOS we load `Helvetica.ttc`; on Windows `arial.ttf` (falling back to Segoe UI).
