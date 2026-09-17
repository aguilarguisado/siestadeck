# apps/desktop/ — @siesta/desktop: the macOS menu bar app

The Stream Deck plugin's readout for people without a Stream Deck: live 5h utilisation beside
the clock, and a menu with the 7d and Fable windows, a one-click account swap, login, and
refresh. **macOS only** — core and the plugin stay cross-platform, this app does not, so
there are no `isMac`/`isWindows` branches in here.

## The single most important architectural fact

**The menu is a native `NSMenu`, built by `Menu.buildFromTemplate`.** There is no renderer
process: no `BrowserWindow`, no HTML, no preload script, no IPC, no `contextBridge`. The
whole app is the main process, and `@siesta/core` runs directly in it exactly as it does in
the plugin's host. `app.dock.hide()` keeps it menu-bar-only.

If you find yourself creating a `BrowserWindow`, you have taken a wrong turn.

## The pure/glue split — this is what keeps the coverage gate green

| File | What it is | Coverage |
|---|---|---|
| `src/menuModel.ts` | Every decision about which rows exist, what they say, whether they are clickable. Pure function over plain data. | 100%, in the gate |
| `src/format.ts` | Percentages and friendly durations. Pure. | 100%, in the gate |
| `src/main.ts` | Electron glue: Tray, Menu, powerMonitor, service wiring. | **excluded** in `vitest.config.ts` |

`menuModel.ts` is to `main.ts` what `../streamdeck/src/actions/draw/*.ts` is to the action
classes. `main.ts` is the **only** file that may be excluded from coverage — the threshold is
a single aggregate 80% across all three workspaces, so glue that grows logic drags the whole
repo down. If a second desktop file starts wanting an exclusion, the logic has leaked into
the glue: move it into `menuModel.ts` instead of listing it.

Nothing outside `main.ts` may import `electron`.

## Rules carried over from the plugin

1. **The view never fetches, polls, or reads a file.** It subscribes to service snapshots and
   rebuilds a menu. All network, file and keychain I/O lives in `@siesta/core`.
2. **`setLogger()` before anything in core runs.** The default sink is a no-op, so anything
   logged earlier is dropped. Unlike the Stream Deck host, `console` *is* safe here — that
   host speaks the plugin protocol over stdio; this process owns its stdio outright.
3. **Start order is load-bearing**: `await accountsService.start()` → `quotaRegistry.start()`.
   The registry reads `accountsService.list()` in `start()`.
4. **Subscribe to `accountsService` *after* `quotaRegistry.start()`.** The registry registers
   its own `"changed"` listener there to re-sync per-account state, and `EventEmitter` runs
   listeners in registration order — going first means `armAutoRefresh()` looks up a state
   that does not exist yet for a newly added account.
5. **`"snapshot"` fires twice for the active account** (`quota.ts:426-434`) — once tagged with
   its slug, once aliased to `null`. Keep the alias, drop the rest, or every refresh repaints
   twice.
6. **Do not start `activeSessionService`.** It tails JSONL files and this app shows no active
   model.
7. **Do not import from `apps/streamdeck`** — that app is not a library. `formatResetTime()`
   lives in its `render/svg.ts` and is tuned for a 144px tile; `src/format.ts` here is the
   menu's own, deliberately wordier, formatter.

## The cross-process seam

Both apps run at once and share `~/.config/siestadeck/accounts.json`, the credential stashes
and the Anthropic rate limit. Read the "Sharing a machine with a second app" section of
`../../packages/core/CLAUDE.md` before touching any of this.

- **`accountsService.reload()` runs when the menu is about to open, and on system wake.**
  `reload()` is pull-only — nothing watches `accounts.json` — so the host has to call it at
  the moments it already treats as "we may have missed something". That is what makes a swap
  on the Stream Deck show up here.
- **This is why the tray has no `setContextMenu()`.** With a context menu set, macOS opens it
  at the `NSStatusItem` level and the `click` event is no longer a hook that runs *before* the
  menu appears. Leaving it unset and calling `tray.popUpContextMenu()` from `click` is what
  buys the pre-open re-read.
- **Never mutate the registry directly** — go through the service, which re-reads before every
  write.
- **No notification on `"swapped"`.** The plugin already raises one, and core keeps that
  decision host-side precisely so one swap does not produce two banners.
- **Auto-refresh is 15 minutes**, matching the plugin's default. The service clamps anything
  under 5. Two apps polling independently means roughly twice the request rate against one
  shared limit; the menu refreshing on open is what actually keeps the numbers current, and
  the timer only exists so the *title* is not stale between opens.
- **`enableAutoRefresh(null, …)` does not follow a swap.** It resolves the `null` to the active
  slug at call time and arms the timer on that account's state, so `armAutoRefresh()` re-arms
  on `"changed"` and stands the previous slug down.

## Build

```bash
npm run desktop         # from the repo root: build + launch
npm run build:desktop   # bundle only
```

- **`tsconfig.json` mirrors `../streamdeck/tsconfig.json`'s `rootDir: "../.."` + `paths`
  trick**, and for the same reason: core is consumed as TypeScript *source*, and `rootDir` is
  what widens `@rollup/plugin-typescript`'s file filter to cover `packages/core/src/**`.
  Narrow it and Rollup reads raw `.ts` and dies with a parse error naming a core file;
  delete it and TS 6 raises TS5011.
- **Rollup outputs CommonJS** to `dist/main.cjs`. Electron supports an ESM main process, but
  it loads the entry asynchronously, which races listener registration against early startup
  events. `electron` is `external` — the runtime injects it; bundling it pulls in the npm
  package's install shim instead of the API.
- **No `terser`**, unlike the plugin: there is no distributable to shrink yet, and an app with
  no devtools debugs entirely through terminal stack traces.
- **The tray icon is a template image.** `assets/tray.svg` → `imgs/trayTemplate.png` (+`@2x`)
  via `scripts/build-tray-icon.mjs`, which runs on `prebuild`. macOS recolours template images
  to match the menu bar and inverts them while the menu is open, which is also why the tray
  *title* carries no colour — `setTitle`'s options only hold `fontType`.
- **CI builds this on macOS only** (`if: matrix.os == 'macos-latest'`). `typecheck` runs on
  both legs and should stay that way. Packaging a signed/notarised `.app` is not in scope yet.
