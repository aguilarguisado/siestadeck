# Changelog

All notable changes to siestadeck are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
