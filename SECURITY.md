# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.0.x   | ✅        |

siestadeck is pre-release; only the most recent published version is supported.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.** Instead, report privately by email:

**Contact:** `4genticdev@gmail.com`
**Subject prefix:** `[siestadeck Security]`

Please include:

- A description of the issue and the impact you believe it has.
- Steps to reproduce, or a proof-of-concept if you have one.
- The plugin version (from `manifest.json` or the Stream Deck plugin store listing) and your OS version.
- Whether you would like to be credited in the changelog if the issue is confirmed.

## Triage

- We aim to acknowledge new reports within **7 days**.
- For confirmed issues we will work with you on a fix and coordinated disclosure timeline. The default disclosure window is **90 days**; we are happy to coordinate something shorter if a fix is ready earlier.

## Scope

siestadeck handles sensitive material — Anthropic OAuth tokens, account metadata, and shells out to OS-level tooling. Security-relevant areas of the codebase include:

- **Credential storage** — `src/services/keychain.ts`, `src/services/accounts.ts`. Reads/writes macOS Keychain entries; never logs token contents.
- **OAuth requests** — `src/services/quota.ts`. Sends bearer-authenticated `GET` requests to `https://api.anthropic.com/api/oauth/usage`; no other endpoints are contacted.
- **Shell-out** — `src/services/terminal.ts`. Uses `osascript` to launch Terminal.app for OAuth login/logout. No untrusted input is interpolated into the script.
- **Local file reads** — `src/services/activeSession.ts`. Read-only access to `~/.claude/` JSONL session transcripts.

If you find that any of these surfaces leak secrets, accept unsafe input, or interact with unexpected network or filesystem locations, that is in scope.

Out of scope: vulnerabilities in upstream dependencies that have not been disclosed by the dependency's maintainers (please report to them first); the Stream Deck SDK itself; Anthropic's API.

## Public disclosure

After a fix has shipped we will publish details in `CHANGELOG.md` and, if appropriate, a GitHub Security Advisory.
