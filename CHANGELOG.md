# Changelog

All notable changes to siestadeck are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
