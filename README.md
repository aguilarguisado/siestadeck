<p align="center"><img src="assets/logo.svg" alt="siestadeck — Time to siesta." width="480"></p>

# siestadeck

> **Time to siesta.** — Live Claude Code telemetry, on your Stream Deck or in your menu bar.

[![CI](https://github.com/aguilarguisado/siestadeck/actions/workflows/ci.yml/badge.svg)](https://github.com/aguilarguisado/siestadeck/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Stream Deck SDK](https://img.shields.io/badge/Stream%20Deck-SDK%20v2-black.svg)](https://docs.elgato.com/streamdeck/sdk/)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-43853d.svg)](https://nodejs.org/)
![Platforms: macOS · Windows](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey.svg)

siestadeck is a live readout of your Claude Code quota, spend, and active model, with a one-press multi-account switcher. It comes as two apps over one core: an Elgato Stream Deck plugin, and a macOS menu bar app for when there's no deck in front of you. Both read from your local `~/.claude/` telemetry plus Anthropic's OAuth usage endpoint, with strict on-demand polling and automatic rate-limit handling.

<p align="center"><img src="assets/deck-screenshot.png" alt="siestadeck on a Stream Deck — 5h and 7d quota meters, active model, account switcher, and an extra-usage readout" width="480"></p>

## Why siestadeck

- **Glanceable quota.** See your 5-hour, 7-day, and per-model Fable weekly Max windows without opening a terminal or the Claude app.
- **Current without being asked.** The numbers keep themselves up to date — every 15 minutes, skipped entirely while you're not using Claude Code, with a hard 5-minute floor, a 5-second throttle on presses, and automatic backoff on `429`. You can turn the background poll off per key and refresh by hand instead.
- **One-press account swap.** Keep your personal and work Claude logins side by side; switch between them instantly from either app, without a browser round-trip.

The plugin is tested on Stream Deck MK.2 (15 keys) on macOS, and designed to also work on XL, +, Mini, Neo, and Pedal. Windows support is in the codebase and CI builds green, but hasn't been validated end-to-end on a physical Windows + Stream Deck setup — community validation welcome. The menu bar app is macOS-only by design.

> **Heads up on the quota endpoint.** The 5h / 7d / Fable weekly numbers come from an undocumented OAuth usage endpoint that Anthropic uses internally. It is aggressively rate-limited and may change without notice. siestadeck never polls it on a tight loop: the background poll is capped at one request every 5 minutes per account, defaults to 15, stops while Claude Code is idle, and backs off on its own if the endpoint pushes back. Using undocumented endpoints is at your own risk — see the [Disclaimer](#disclaimer) below.

## Install

The easiest way to get siestadeck onto your deck:

1. Download the latest `siestadeck.streamDeckPlugin` from the [**Releases**](https://github.com/aguilarguisado/siestadeck/releases) page.
2. Double-click the downloaded file. Stream Deck installs the plugin and the **siestadeck** action category appears in the right sidebar.
3. Drag the actions you want onto your keys.

On first run the plugin auto-adopts whatever account Claude Code is currently logged in as — no extra setup needed.

**First-run note (macOS):** the OS will prompt for permission to access the `Claude Code-credentials` keychain entry. Click **Always Allow** — otherwise the quota meter stays on `--%`.

## The macOS menu bar app

The same readout, in the menu bar — for when the deck isn't there, or isn't yours.

```sh
npm run desktop
```

Your live 5-hour utilisation sits next to the clock. Click it for the rest:

```
5h · 18% · resets in 1h 15m
7d · 76% · resets in 2d 3h
Fable · 85% · resets in 2d 3h
──────────────────────────────
Account: work
Switch to home
Log in to Claude…
──────────────────────────────
Quit Siesta
```

Opening the menu *is* the refresh: the click fires one, and the numbers fill in while you're looking at them. That's why there's no Refresh row — and between opens, the percentage next to the clock keeps itself current on its own.

**Switch to …** names the login you'll land on and cycles through every saved account, exactly like the Switch Account key. Both apps read the same account registry and the same quota, so you can run them together and either one can drive a switch the other picks up — the menu re-reads the registry every time it opens.

macOS only, and not packaged as a signed `.app` yet: it runs from source. Everything else about it — the credentials, the polling limits, the privacy story below — is identical to the plugin, because it is the same core.

## Build from source

If you'd rather build it yourself (or want to hack on it):

```sh
git clone https://github.com/aguilarguisado/siestadeck.git siestadeck && cd siestadeck
npm install
npm run icons      # rasterize SVGs → manifest PNGs
npm run build      # bundle plugin.js into the .sdPlugin/bin/ directory
npm run link       # symlink the plugin into Stream Deck
```

All commands run from the repo root — it's an npm-workspaces monorepo, and the unprefixed build scripts delegate to the `@siesta/streamdeck` workspace.

Open Stream Deck — the siestadeck actions appear in the right sidebar under their own category.

## Actions

siestadeck ships five actions. They appear in the Stream Deck sidebar under their own **siestadeck** category — drag any of them onto a key.

<p align="center"><img src="assets/actions-sidebar.png" alt="The siestadeck action category in the Stream Deck sidebar: Quota Meter, Extra Usage, Active Model, Switch Account, Login / Logout" width="240"></p>

| Action | What it shows | Press to | PI options |
|---|---|---|---|
| **Quota Meter** | Radial 5h, 7d, or Fable weekly quota %, color-coded green/amber/red | Force-refresh the quota | Window, auto-poll on/off + interval |
| **Extra Usage** | Real pay-as-you-go spend billed beyond your Max plan this month, with the monthly cap | Force-refresh the quota | — |
| **Active Model** | Current model (Opus / Sonnet / Haiku) with version | Cycle the default model | — |
| **Switch Account** | Active account or "→ next" hint | Cycle or jump to a specific account | Mode, target |
| **Login / Logout** | `log in` / `log out` / `+ account` | Open Terminal with the matching `claude auth …` command | Mode, display name |

## Quota polling

The quota endpoint is the only piece of siestadeck that talks to Anthropic's servers. Everything else reads from local files. Polling behavior:

- **Default: every 15 minutes, for the account you're actually on.** A key that shows quota keeps itself current while it's on screen and stops asking the moment it isn't. Switch accounts and the poll follows you.
- **One request when a key first appears**, so a reloaded plugin shows a real number straight away instead of `--%` until the first tick.
- **Nothing at all while you're not using Claude Code.** If Claude Code itself hasn't touched a project in 20 minutes, the background tick is skipped — a machine left running overnight makes no requests.
- **5-minute hard floor.** You can set a longer interval per key in the Property Inspector, or untick auto-refresh and press for it instead. You cannot set it below 5 minutes.
- **A press is throttled to one request every 5 seconds**, per account, however fast you press. The menu bar app's refresh-on-open lands on the same throttle.
- **One catch-up after sleep, or when the deck comes back.** Waking the machine, or plugging the Stream Deck back in, schedules a single refresh a few seconds later, and only if what's on screen is older than your interval — timers don't run while a laptop is asleep, and nothing polls while the deck is away, so otherwise the number would sit there stale. A wake and a reconnect arriving together still cost one request.
- **Automatic backoff on `429`.** If the endpoint rate-limits you, the plugin backs off (1 → 10 minutes) before trying again, regardless of the configured interval.

In practice this means a few dozen requests on a working day, and none on a day you don't open Claude Code.

## Multi-account setup

siestadeck is designed for **one person** who has more than one Claude account they personally control — for example, a personal account and a work account. Each account is a single keychain entry (`siestadeck-token-<slug>`) plus a row in `~/.config/siestadeck/accounts.json`. Only accounts you log into yourself on this machine are saved.

**Adding accounts**

1. Drop a **Login / Logout** key on your deck and set its mode to **Add account** with a display name (e.g. `work`).
2. Press the key. Terminal opens running `claude auth login`.
3. Complete the browser OAuth flow.
4. When you press Enter at the prompt, siestadeck captures the new credentials and saves them as a new account.

**Swapping**

Use a **Switch Account** key in cycle mode to rotate through your accounts, or set a key's target to a specific account for a direct jump. The swap is instant — no browser, no logout.

There's no limit on how many accounts you can keep. Cycle mode is a round-robin in the order you added them, so with three accounts a key press goes first → second → third → first, and the Property Inspector dropdown lists them in that same order.

> **Please don't use this to share a Claude account with other people.** The Claude Max plan is for individual use; sharing credentials across teammates violates Anthropic's terms. siestadeck is a personal multi-account convenience tool, not a team-sharing workaround.

## Privacy & data flow

siestadeck is a local utility. It does not phone home, does not collect analytics, and does not contact any third party other than Anthropic's official API. Specifically:

- **Reads** your Claude Code OAuth token from the OS credential store — macOS Keychain entry `Claude Code-credentials`, or on Windows the `claude` CLI's `~/.claude/.credentials.json`. Written by Anthropic's `claude` CLI, not by this plugin.
- **Reads** `~/.claude/projects/*/*.jsonl` transcripts from your local disk to surface the active model.
- **Sends** authenticated `GET` requests to `https://api.anthropic.com/api/oauth/usage` with that token in the `Authorization` header. The response carries your 5h/7d quota, per-model weekly limits (Fable), and your pay-as-you-go extra-usage spend. No other data is sent; no other endpoint is contacted.
- **Writes** per-account credentials so you can switch without re-logging in. macOS: Keychain entries named `siestadeck-token-<slug>`. Windows: DPAPI-encrypted files under `%APPDATA%\siestadeck\creds\` (each blob is encrypted with the Windows user's DPAPI key — only that account can decrypt).
- **Writes** an account registry containing only display name, email, slug, color, and tier — no tokens. Path: `~/.config/siestadeck/accounts.json` (macOS) or `%APPDATA%\siestadeck\accounts.json` (Windows).
- **Opens** Terminal.app via `osascript` (macOS) or `cmd /k` (Windows) for OAuth login/logout flows so you can complete the browser auth round-trip yourself.

No analytics, no telemetry, no third-party servers. The source is open — verify it yourself.

## Extra Usage

The **Extra Usage** action shows a real dollar figure — not an estimate. It comes straight from the `extra_usage` block of Anthropic's OAuth usage response: the pay-as-you-go amount Anthropic has billed you for usage **beyond** your Claude Max subscription this month, alongside your configured monthly cap.

A few things to know:

- If you stay within your Max plan windows (5h / 7d / Fable weekly) and have never enabled pay-as-you-go, this reads `off` — there is no overage to show.
- It is **not** "what your usage would have cost on the API," and it does not include the value of your subscription itself. It is purely the metered overage.
- It refreshes on the same endpoint and the same schedule as the Quota Meter, and keeps itself current on its own even if it's the only siestadeck key on your deck.

siestadeck deliberately does **not** ship a guessed-from-tokens cost estimate. For a local per-session cost breakdown, `npx ccusage daily` is the right tool.

## Configuration

| Path | What |
|---|---|
| `~/.claude/projects/*/*.jsonl` | Active-session transcripts the Active Model service tails (read-only) |
| `~/.config/siestadeck/accounts.json` | The plugin's account registry (slug, label, email, color, tier) |
| Keychain: `Claude Code-credentials` | Claude Code's own OAuth token (read by the plugin's "active account" poller) |
| Keychain: `siestadeck-token-<slug>` | The plugin's per-account credential stash |

## Troubleshooting

- **Quota meter stuck on `--%`** — most likely the macOS Keychain prompt was dismissed. Run `security find-generic-password -s "Claude Code-credentials" -w` in a terminal once, click "Always Allow", then press the Quota Meter key.
- **The number didn't move for a while** — background ticks are skipped while Claude Code has been idle for 20+ minutes, and pressing refreshes at most once every 5 seconds. Press the key once you're working again.
- **`HTTP 429` in the plugin log** — the OAuth endpoint is aggressively rate-limited. The plugin backs off automatically (1 → 10 minutes); just wait it out, or lengthen the interval in the Quota Meter's Property Inspector.
- **A new account I added isn't showing up in the PI dropdown** — close and reopen the Property Inspector, or restart the plugin with `npm run restart`.
- **Extra Usage shows `off`** — that's expected unless you've enabled pay-as-you-go billing beyond your Max plan. It only shows a dollar figure when Anthropic is actually metering overage.

## Repo layout

siestadeck is two apps in an npm-workspaces monorepo. Everything that isn't UI — quota polling, credential handling, the account registry, session tailing — lives in `@siesta/core`, which is why the menu bar app can offer the same readout with no Stream Deck attached.

```
packages/core/       @siesta/core — no UI dependencies of any kind
  src/               quota poller, active-session watcher, accounts, keychain, terminal
                     *Policy.ts siblings hold the pure, heavily-tested logic
  src/log.ts         the one host seam: the app binds a log sink at startup

apps/streamdeck/     @siesta/streamdeck — this plugin
  src/actions/       one TS file per Stream Deck action
    draw/            pure, testable render cores for each action
  src/render/        SVG templates + theme tokens
  src/plugin.ts      entry point: binds the log sink, registers actions
  assets/icons/      hand-authored SVG glyphs (source of truth for action icons)
  scripts/           Node utilities (icon rasterizer, release-readiness check)
  io.github.aguilarguisado.siestadeck.sdPlugin/
    manifest.json    Stream Deck plugin manifest
    bin/             rollup output (gitignored)
    imgs/            rasterized PNGs (built from assets/icons/*.svg, gitignored)
    pi/              Property Inspector HTML

apps/desktop/        @siesta/desktop — the macOS menu bar app (macOS only)
  src/main.ts        entry point: the whole app is Electron's main process —
                     a native NSMenu, no renderer, no BrowserWindow, no IPC
  src/menuModel.ts   pure, tested: snapshot + accounts → menu rows
  src/format.ts      pure, tested: percentages and reset countdowns
  assets/tray.svg    menu bar glyph (source of truth for the template icon)
  imgs/              rasterized tray PNGs (gitignored)
  dist/              rollup output (gitignored)

assets/              brand assets (logo, screenshots)
```

## Contributing

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for prerequisites, local setup, and the architectural rules (the most important: **actions are stateless renderers** — they never poll, fetch, or read files; all I/O lives in services). The per-directory `CLAUDE.md` files document each layer in detail.

Security issues: please report privately per [SECURITY.md](SECURITY.md).

## Acknowledgements

- [Elgato](https://www.elgato.com/) for the Stream Deck SDK.
- [Anthropic](https://www.anthropic.com/) for the `claude` CLI and the data formats this plugin reads.
- [`@resvg/resvg-wasm`](https://github.com/yisibl/resvg-js) for the SVG-to-PNG rendering pipeline.

## Disclaimer

siestadeck is provided **as-is**. It reads your own local telemetry and calls endpoints using credentials you own, but Anthropic's Terms of Service — not this project — govern your account. The authors and contributors are **not responsible** for any account suspension, rate limiting, credential revocation, billing dispute, or other action taken against your Claude account, Anthropic API access, or Elgato Stream Deck setup as a result of using this plugin. The quota endpoint is undocumented and may change or be withdrawn at any time. If you're not comfortable with that risk, don't install the plugin.

## License

MIT. See [LICENSE](LICENSE). © 2026.

---

*siestadeck is an independent open-source project. It is not affiliated with, endorsed by, or sponsored by Anthropic. "Claude" is a trademark of Anthropic, PBC. "Elgato" and "Stream Deck" are trademarks of Corsair Memory, Inc.*
