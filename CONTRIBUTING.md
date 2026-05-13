# Contributing to siestadeck

Thanks for your interest. This is a small project but PRs and issues are welcome.

## Prerequisites

- **Node.js ≥ 20** (the Stream Deck host runs Node 20; CI runs Node 22).
- **Stream Deck app ≥ 6.5** with the [Elgato CLI](https://docs.elgato.com/streamdeck/sdk/) installed (`npm i -g @elgato/cli` or use the bundled `npx streamdeck`).
- **macOS 12+** or **Windows 10+**. macOS is the day-to-day target and is what the maintainer validates against; Windows builds in CI but hasn't been validated end-to-end on a physical Windows + Stream Deck setup — Windows contributors and bug reports are very welcome.
- A physical Stream Deck (or the Elgato Stream Deck Mobile app) for end-to-end testing.

## Local setup

```sh
git clone https://github.com/aguilarguisado/siestadeck.git && cd siestadeck
npm install
npm run icons       # rasterize SVGs → PNG assets (also runs as a prebuild hook)
npm run build       # bundle the plugin into io.github.aguilarguisado.siestadeck.sdPlugin/bin/
npm run link        # symlink the plugin into Stream Deck (one-time)
npm run watch       # rebuild + restart the plugin on every save
```

The dev happy-path is `npm run watch`. Every save rebuilds, then runs `streamdeck restart io.github.aguilarguisado.siestadeck`; the plugin reloads in Stream Deck within ~1 second. No manual reload needed.

Useful one-off commands:
- `npm run validate` — validate `manifest.json` against the Stream Deck SDK.
- `npm run restart` — reload the plugin in the running Stream Deck app.
- `npm run pack` — produce a `.streamDeckPlugin` distributable (runs the release-readiness check first).
- `npm run check:release` — verify no `<TODO>` placeholders or the legacy `com.juan.*` UUID remain.

## Architecture rules

Before changing code, read the per-directory `CLAUDE.md` files — they document the architecture in detail. The non-negotiable rules:

1. **Actions are stateless renderers.** They never poll, never fetch, never read files. They subscribe to a service snapshot and re-render. All polling, file watching, network calls, rate-limiting, and caching live in `src/services/`.
2. **Services are EventEmitter singletons.** Each exports a single default instance (`accountsService`, `quotaRegistry`, `activeSessionService`). Never `new` them in actions.
3. **`Bundler` resolution + `.js` import suffixes.** Even though sources are `.ts`, intra-repo imports use the `.js` extension (see `src/plugin.ts:3-13`). Don't strip them.
4. **`unref()` every long-lived timer** that should not keep the Node event loop alive. The plugin host shuts down cleanly only if no live timers remain.

## Pull request conventions

- Keep PRs small and focused. One concern per PR.
- Run `npm run validate` and `npm run build` locally before pushing — CI will run them, but failing fast saves time.
- For UI/SVG changes: include before/after screenshots of the rendered key.
- For new public surface (services, actions): update the relevant `CLAUDE.md`.

## Type checking

There is no separate type-check command — `rollup -c` (which runs `@rollup/plugin-typescript` in strict mode) is the correctness gate. If `npm run build` succeeds, types are fine.

## Reporting issues

Use the issue templates in `.github/ISSUE_TEMPLATE/`. For security issues, please follow [SECURITY.md](SECURITY.md) — don't open a public issue.

## Code of Conduct

Participation in this project is governed by our [Code of Conduct](CODE_OF_CONDUCT.md).
