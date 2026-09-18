# Changelog

All notable changes to siestadeck are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **A macOS menu bar app, for people without a Stream Deck.** `npm run desktop` puts your live 5h utilisation next to the clock and a native menu behind it: the 5h, 7d and Fable windows with their reset countdowns, the account you're on with a **Switch to …** item naming the one you'd land on, and a sign-in item. It reads the same accounts and the same quota as the plugin, so the two agree and either can drive a switch the other picks up. Only one copy can run at a time, so a second launch won't give you a second menu bar icon. Not packaged as a signed `.app` yet — it runs from source.
- **Keys fetch as soon as they appear with nothing to show.** A reloaded plugin, or a deck plugged back in, used to sit on `--%` until you pressed it. It now asks once on appearing — even if Claude Code has been idle, since you are evidently right there — and then settles into the normal interval.
- **One catch-up refresh after the machine wakes.** Timers don't run while a laptop is asleep, so a 15-minute poll armed at midnight hadn't come due at breakfast and yesterday's percentage just sat there. Waking now schedules a single refresh a few seconds later — long enough for Wi-Fi to come back — and only when what's on screen is already older than your own interval. Nothing is fetched for a key whose auto-refresh is off.

### Fixed
- **The "LOG IN" tile no longer survives the login that fixes it.** After signing in, the Quota Meter could stay stuck asking for a login indefinitely: pressing it reopened Terminal for another `claude auth login` without ever re-reading the credentials, so a successful sign-in changed nothing on the deck and the next press asked again. A press now retries the credentials first and only offers the sign-in flow if that still fails. The 30-minute auth cooldown is also scoped to the token that actually failed, so it is dropped the moment a different credential is on file — whether you signed in through Siesta, through Terminal yourself, or Claude Code rotated its own. A genuine `429` still runs its full course.
- **Switching accounts no longer revokes the account you switch to.** OAuth refresh tokens are single-use, so once Claude Code had refreshed its own credentials, the copy Siesta had stashed for that account was not merely older — it was retired, and Anthropic rejected it. Swapping wrote that dead copy over a perfectly good live login, which cost you the session and parked the tile on "LOG IN" with nothing left to recover from. A swap now keeps the live credentials when they are provably the same account and outlive the stash. Identity is still confirmed against `/profile`, never assumed, so another account's credentials can never be adopted this way.
- **Switch Account cycle mode now rotates through every account, not just two.** The account list was ordered most-recently-used first, and swapping stamped that timestamp — so "next" always resolved to the account you had just left. With three or more accounts the key bounced between the same two and the rest were never reachable. Cycling now follows a fixed order (the order accounts were added), so *N* presses visit *N* accounts and wrap. The unreachable accounts were never lost: they stayed in the registry with their credentials intact, just invisible to the key.
- **Accounts are no longer removed when their owner can't be confirmed.** The startup check that cleans up cross-wired credentials treated an unreachable `/profile` lookup — offline, a `5xx`, a rate limit — as proof of corruption, and dropped every account sharing a token. An unreachable endpoint says nothing about the account, so removal now requires a positive identification of a *different* owner; unconfirmed duplicates are logged, left alone, and re-checked on the next start.
- **An interrupted write can no longer blank the account registry.** `accounts.json` is now written to a temporary file and renamed into place, so a crash mid-write leaves the previous registry intact instead of a truncated file that reads back as "no accounts at all".

### Changed
- **The quota now keeps itself current, instead of waiting to be pressed.** Auto-refresh is on out of the box — every 15 minutes, for as long as a key that shows quota is on screen — where it previously had to be found and ticked in the Property Inspector. Every guard rail that made polling safe is unchanged and still enforced: a 5-minute hard floor, no requests at all while Claude Code has been idle for 20+ minutes, one request per account per 5 seconds however fast you press, and the 1 → 10 minute backoff on a `429`. You can still untick it per key and refresh by hand.
- **The background poll follows the account you're on.** It used to bind to whichever account was active when the timer was armed, so after a switch it kept polling the account you'd left, and the tile you were looking at went stale until you pressed it.
- **Turning auto-refresh off on one Quota Meter key no longer switches it off for the others.** The setting is per key, but the timer was shared: whichever key was configured last decided for all of them. Each key now speaks only for itself, and the shortest interval any visible key asks for is the one that runs — still one request for the whole deck, not one per key. The **Extra Usage** key, which has no Property Inspector, now keeps itself current too.
- **The menu bar app's Refresh row is gone.** Opening the menu already fires a refresh, and the numbers now land in the menu while it's open rather than showing up on the next open — so the button could only ever repeat what opening the menu had just done.
- **Accounts are listed oldest-first everywhere.** The Switch Account cycle and the Property Inspector dropdowns share one stable order, so the dropdown no longer reshuffles after each swap and its order tells you what the next press will do.
- **Per-account colors expanded from 6 to 20** so larger account sets stay distinguishable. Existing accounts keep the colors they already have. There is still no limit on how many accounts you can add — past 20 the colors repeat.

## [0.1.0] - 2026-07-22

### Added
- **Quota Meter — Fable weekly window** — a third window option alongside 5h and 7d, surfacing claude.ai's per-model **Fable** weekly Max limit as the same radial gauge, with a `FABLE` label pill, reset countdown, and the siesta / `WAIT` / `LOG IN` states. Reads the new `limits` array (`kind: "weekly_scoped"`), since the legacy `seven_day_opus` / `seven_day_sonnet` fields now return `null`.

### Removed
- **Attention** action — the alerting tile that flashed when a Claude Code session was waiting on you (permission prompts, questions, finished turns). Detection proved unreliable, and lighting it up meant Claude Code hooks firing on every event, machine-wide — too much cost for too little signal. siestadeck stays focused on quota, spend, model, and account switching.
  - **Cleanup for source builds:** released binaries (v0.0.1) never shipped this action, so most users are unaffected. If you built `main` from source and pressed the Attention key at least once, it installed hooks into `~/.claude/settings.json` — and the in-app "Uninstall hooks" button is gone with the action. Remove them by hand: delete the seven hook entries whose command appends to `~/.claude/siestadeck/attention.jsonl` (under the `Notification`, `Stop`, `UserPromptSubmit`, `PreToolUse`, `SessionStart`, `SessionEnd`, and `PostToolUse` events), then delete the `~/.claude/siestadeck/` directory.

### Fixed
- **Quota Meter now shows a distinct "LOG IN" tile when your OAuth login is lost**, instead of an amber `WAIT 1800s` badge that was indistinguishable from a real rate limit. Pressing the key while logged out runs `claude auth login` and polls for the new credentials, and the gauge recovers within seconds of re-login rather than staying parked for the 30-minute auth cooldown. A genuine `429` still shows the `WAIT Xs` badge.
- **Active Model tile no longer clips the Fable model name** — `claude-fable-5` rendered as `ude-fabl`. The Fable family now maps to a clean violet `Fable` label, and the shared `renderValueKey` shrinks and ellipsizes any overflowing value instead of edge-clipping.

## [0.0.1] - 2026-05-14

### Added
- **Quota Meter** action — radial 5h or 7d Claude Max quota %, color-coded green/amber/red. Manual refresh on key press by default; optional auto-refresh with a 5-minute minimum interval and automatic `429` backoff.
- **Extra Usage** action — real pay-as-you-go spend billed beyond your Claude Max plan this month, with the monthly cap. Read straight from the `extra_usage` block of Anthropic's OAuth usage response — a billed figure, not an estimate.
- **Active Model** action — current default Claude model (Opus / Sonnet / Haiku) with version, surfaced from the local session transcripts.
- **Switch Account** action — instant swap of the active Claude Code account (cycle or direct-jump), with no browser round-trip.
- **Login / Logout** action — opens Terminal with the matching `claude auth …` command, capturing new credentials into siestadeck on completion.
- Multi-account credential storage: macOS Keychain (`siestadeck-token-<slug>`) and Windows DPAPI-encrypted blobs under `%APPDATA%\siestadeck\creds\`.
- Property Inspector dropdowns for account selection per action.
- macOS 12+ support, validated end-to-end. Windows 10+ support builds in CI but has not yet been validated on a physical Windows + Stream Deck setup.

### Security
- OAuth tokens are read from and written to the OS credential store only (macOS Keychain / Windows DPAPI). No tokens are ever written to disk in plaintext or to the account registry JSON.
- Only one external network endpoint is contacted: `https://api.anthropic.com/api/oauth/usage`. No analytics, no telemetry, no third-party servers.
- Quota refresh is manual by default; the optional auto-refresh is rate-limited to one request per 5 minutes per account with automatic `429` backoff (1 → 10 minutes).
