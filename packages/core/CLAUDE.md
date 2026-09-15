# packages/core/ — @siesta/core: data, business logic, lifecycle

All polling, file watching, network calls, keychain I/O, and rate-limiting live here. Each service is an `EventEmitter` singleton exported as a `const` at the bottom of its file (e.g. `quota.ts:422`, `accounts.ts:608`). Actions consume snapshots; they do not own state.

## The three data sources

1. **Local telemetry** — `~/.claude/projects/<slug>/*.jsonl` (live session transcripts), tailed by `activeSession.ts` to surface the active model.
2. **OS credential store** — abstracted by `credentialStore.ts`. On macOS, the `Claude Code-credentials` keychain entry is what Claude Code itself reads; `siestadeck-token-<slug>` is the per-account stash this plugin maintains via `security(1)`. On Windows, the active credentials live in `~/.claude/.credentials.json` (read by `keychain.ts`) and per-account stashes are DPAPI-encrypted files under `%APPDATA%\siestadeck\creds\` (via PowerShell `ProtectedData.Protect/Unprotect`). Service constant `CLAUDE_KEYCHAIN_SERVICE` and the per-account prefix `siestadeck-token` are defined in `keychain.ts:7` and `accounts.ts:29`.
3. **Anthropic OAuth** — undocumented `https://api.anthropic.com/api/oauth/usage` and `/profile` endpoints, both requiring `anthropic-beta: oauth-2025-04-20`. See `quota.ts:24,30` and `accounts.ts:492-496`.

## Lifecycle: eager vs lazy

| Service | Mode | Started in | Why |
|---|---|---|---|
| `accountsService` | eager | `plugin.ts` | Must be ready before any action queries it. |
| `quotaRegistry` | eager (timers off by default) | `plugin.ts` | Per-account state needs to exist; the network polling itself is opt-in. |
| `activeSessionService` | **lazy** | `acquire(id)` from any action that needs it | Tails JSONL files; spinning up a watcher for a key the user never displays is wasteful. |

Lazy services use **reference-counted consumers**: the watcher starts on the first `acquire()` and stops when the last consumer `release()`s. See `activeSession.ts`. `releaseAll()` exists for the device-disconnect path in `plugin.ts`.

## Quota refresh policy (the non-obvious part)

`QuotaRegistry` (`quota.ts:80-420`) enforces several layers of rate-limiting. **Do not bypass these** — Anthropic's endpoint will 429 you and the plugin's UX depends on the backoff being respected:

- **5-second floor per account** (`MIN_REFRESH_GAP_MS`, `quotaPolicy.ts:7,189`) — calls to `refresh(slug)` within 5s of the last attempt return the cached snapshot instead of hitting the network. Coalesces rapid PI fiddling and double-presses.
- **429 backoff: 1→10 minutes** (`MIN_BACKOFF_MS`, `MAX_BACKOFF_MS`, `quotaPolicy.ts:5-6,124-126`; the 429 branch is `quota.ts:175`) — a 429 sets `backoffUntil`. Refreshes during the cooldown re-emit a snapshot with the wait time so actions can render a "WAIT Xs" countdown without touching the network.
- **401/403 auth backoff: 30 minutes, but scoped to one credential** (`UNAUTHORIZED_BACKOFF_MS`) — a 401 whose token refresh also fails parks the account and the tile renders `LOG IN` instead of the `WAIT` badge. The backoff is recorded against the *token* that failed (`authFailedToken`), so any later refresh that finds a **different** credential on file drops it and retries at once (`shouldClearAuthBackoff`) — the user signed in again, or Claude Code rotated the live entry. Never widen this to `rate`: a 429 is a verdict on the caller, and no amount of re-authenticating earns the quota back.
- **Idle gating** (`IDLE_THRESHOLD_MS`, `quotaPolicy.ts:8`; the gate is `quota.ts:312`) — auto-refresh ticks check `isClaudeIdle(20min)` against `~/.claude/projects/` mtime (`idle.ts`). If Claude Code itself hasn't been active in 20 minutes, the auto tick is skipped. Manual `refresh()` calls are unaffected.
- **Auto-refresh is opt-in.** No timers run until `enableAutoRefresh(slug, ms)` is called. Cadence is clamped to ≥5 minutes (`quota.ts:302`).
- **Wake handling: `markAwake()` only clears the 5s coalesce window** (`quota.ts:351-353`). It does **not** auto-fetch — the user has to press a key after sleep. This is intentional: laptops resume into all sorts of network states.

## Multi-account architecture

`accountsService` (`accounts.ts`) maintains a registry on disk at `~/.config/siestadeck/accounts.json` plus per-account credential stashes in the keychain.

- **Adoption on first run** (`accounts.ts:303-351`) — if Claude Code is already logged in to an account the plugin hasn't seen, copy those creds into a new account slug (using the email prefix as the display name) so the user doesn't have to re-auth.
- **New-login polling** (`accounts.ts:430-461`) — Login/Logout action spawns a Terminal running `claude auth login`; this method polls the keychain entry every 2s for ≤3 min, adopts whatever lands, emits `changed`. Used because there's no other signal that the OAuth flow finished.
- **Atomic swap** — `swap(slug)` makes `slug`'s credentials the ones Claude Code reads, updates the registry, and emits `changed` + `swapped`. Normally that means writing the per-account stash into `Claude Code-credentials`; the `add-generic-password -U` flag overwrites in place, so Claude Code never sees an empty/inconsistent state. **The exception is load-bearing:** when the live entry already belongs to this account *and* outlives the stash (`preferLiveOverStash`, identity proved via `/profile`), the stash is the staler copy and we adopt live instead. OAuth refresh tokens are single-use, so writing back a stash Claude Code has already rotated past doesn't restore the account, it revokes it — 401, refused refresh, and a 30-minute `LOG IN` tile.
- **Unbounded, stably ordered** — the registry holds any number of accounts. `list()` returns them in `stableOrder` (oldest first by `addedAt`, tie-broken by slug), and both the Switch Account round-robin (`pickNextSlug`) and the PI dropdown walk that sequence. Never sort this by `lastUsedAt`: `swap()` stamps it, so a recency order makes "next" mean "the one I just left" and pins the cycle to two accounts no matter how many are saved. `SOFT_ACCOUNT_LIMIT` (20) is a log threshold and the palette length — not a cap.
- **Removal requires proof** — `removeCrossWiredStashes()` deletes registry rows only for stashes whose real owner `/profile` confirmed as someone else. A duplicate group whose owner can't be resolved comes back from `detectCorruptedStashes` as `unresolved`: log it, leave it, re-check next start. Treating an unreachable `/profile` as corruption once deleted accounts on every offline launch.

## Credential store (`credentialStore.ts`, `keychain.ts`)

`credentialStore.ts` defines the `CredentialStore` interface and selects an implementation by platform:

- **macOS** — `security find-generic-password -w` / `add-generic-password -U`. The `-U` (update) flag is what makes account swaps atomic. Don't replace with a Node keytar binding — `security(1)` is universal across macOS versions and has zero install footprint.
- **Windows** — PowerShell shell-out to `[System.Security.Cryptography.ProtectedData]::Protect/Unprotect` under `CurrentUser` scope. Encrypted blobs live as one file per credential under `%APPDATA%\siestadeck\creds\<sha1(service__account)>.bin`. No native module needed; a per-process in-memory cache amortizes the ~150–300 ms PowerShell spawn cost.

`keychain.ts` is the higher-level layer: `readClaudeCredentials()` / `snapshotClaudeCredentials()` / `writeClaudeCredentials()` know about each platform's location for the **active** Claude Code credential (Keychain entry on macOS, `~/.claude/.credentials.json` on Windows). `readGenericPassword` / `writeGenericPassword` are thin pass-throughs to `credentialStore` and are what `accounts.ts` uses for the per-account stashes.

## The host seam — what this package may not do

This package is consumed by more than one app, so it must not assume which. CI enforces the headline rule by grepping `packages/core/src` for `@elgato`; the rest is convention.

- **Never import a host SDK.** No `@elgato/streamdeck`, no Electron, no rendering library. If you find yourself wanting one, the code belongs in the app.
- **Log through `log()`** from `log.ts`, never `console`. The host binds the sink once at startup via `setLogger()`. The default is a **no-op, not `console`** — the Stream Deck SDK speaks over stdio, so a stray `console.log` from an unbound core corrupts that channel. Anything logged before `setLogger` is dropped silently.
- **Don't decide to interrupt the user.** Emit an event and let the host choose whether that becomes a notification. `terminal.ts` exports `notify()` as a cross-platform convenience, but no service in here calls it — `swap()` emits `"swapped"` and the host raises the banner. Once a second app watches the same registry, one swap must not produce two banners, and keeping the decision host-side is what makes that possible.
- **Anything reachable must be in `index.ts`.** `package.json`'s `exports` has a single `"."` entry, so the barrel *is* the API. Adding to it is a decision: prefer a method on the owning service over exporting a loose helper.
- **Write files through `writeJsonAtomic`** (`atomicJson.ts`) — temp file + `rename(2)`, so no reader ever sees a truncated document. For `~/.claude/settings.json`, which Claude Code owns, use `updateClaudeSettings(fn)` so only the keys you name change.

## Adding a new service

1. Extend `EventEmitter`, export as a singleton at the bottom of the file.
2. Decide eager or lazy. If lazy, implement `acquire(id)` / `release(id)` / `releaseAll()` exactly like `activeSession.ts`.
3. Define a `Snapshot` type. Compute a fingerprint string and short-circuit emits when nothing meaningful changed (`activeSession.ts:202-204`).
4. `unref()` every timer and watcher so the plugin host can exit cleanly.
5. Export whatever a host genuinely needs from `index.ts` — and nothing else.
6. Register subscriptions or eager start in `apps/streamdeck/src/plugin.ts`. Wire device-disconnect / device-connect handlers if the service should suspend when no Stream Decks are visible.

## Known gap: this package assumes it is the only process

Every rate-limit and registry invariant in here is per-process, in-memory state. That holds today because the Stream Deck plugin is the only consumer; it stops holding the moment a second app runs alongside it. See the follow-up issue before building `apps/desktop` — in particular `accounts.ts` reads the registry from disk once in `start()` and never re-reads it, while seven call sites write the whole document back.
