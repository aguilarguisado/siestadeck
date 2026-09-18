# packages/core/ — @siesta/core: data, business logic, lifecycle

All polling, file watching, network calls, keychain I/O, and rate-limiting live here. Each service is an `EventEmitter` singleton exported as a `const` at the bottom of its file (e.g. `quota.ts:459`, `accounts.ts:801`). Actions consume snapshots; they do not own state.

## The three data sources

1. **Local telemetry** — `~/.claude/projects/<slug>/*.jsonl` (live session transcripts), tailed by `activeSession.ts` to surface the active model.
2. **OS credential store** — abstracted by `credentialStore.ts`. On macOS, the `Claude Code-credentials` keychain entry is what Claude Code itself reads; `siestadeck-token-<slug>` is the per-account stash this plugin maintains via `security(1)`. On Windows, the active credentials live in `~/.claude/.credentials.json` (read by `keychain.ts`) and per-account stashes are DPAPI-encrypted files under `%APPDATA%\siestadeck\creds\` (via PowerShell `ProtectedData.Protect/Unprotect`). Service constant `CLAUDE_KEYCHAIN_SERVICE` and the per-account prefix `siestadeck-token` are defined in `keychain.ts:7` and `accounts.ts:30`.
3. **Anthropic OAuth** — undocumented `https://api.anthropic.com/api/oauth/usage` and `/profile` endpoints, both requiring `anthropic-beta: oauth-2025-04-20`. See `quota.ts:24,30` and `accounts.ts:657-662`.

## Lifecycle: eager vs lazy

| Service | Mode | Started in | Why |
|---|---|---|---|
| `accountsService` | eager | `plugin.ts` | Must be ready before any action queries it. |
| `quotaRegistry` | eager (timers off until a view asks) | `plugin.ts` | Per-account state needs to exist; the polling is refcounted by `requestAutoRefresh`. |
| `activeSessionService` | **lazy** | `acquire(id)` from any action that needs it | Tails JSONL files; spinning up a watcher for a key the user never displays is wasteful. |

Lazy services use **reference-counted consumers**: the watcher starts on the first `acquire()` and stops when the last consumer `release()`s. See `activeSession.ts`. `releaseAll()` exists for the device-disconnect path in `plugin.ts`.

## Quota refresh policy (the non-obvious part)

`QuotaRegistry` (`quota.ts:80-457`) enforces several layers of rate-limiting. **Do not bypass these** — Anthropic's endpoint will 429 you and the plugin's UX depends on the backoff being respected:

- **5-second floor per account** (`MIN_REFRESH_GAP_MS`, `quotaPolicy.ts:7,189`) — calls to `refresh(slug)` within 5s of the last attempt return the cached snapshot instead of hitting the network. This is the only throttle a manual refresh needs, and it is why neither host rate-limits its own UI: a key held down, and `apps/desktop` refreshing on every menu open, both land here.
- **429 backoff: 1→10 minutes** (`MIN_BACKOFF_MS`, `MAX_BACKOFF_MS`, `quotaPolicy.ts:5-6,124-126`; the 429 branch is `quota.ts:214`) — a 429 sets `backoffUntil`. Refreshes during the cooldown re-emit a snapshot with the wait time so actions can render a "WAIT Xs" countdown without touching the network.
- **401/403 auth backoff: 30 minutes, but scoped to one credential** (`UNAUTHORIZED_BACKOFF_MS`) — a 401 whose token refresh also fails parks the account and the tile renders `LOG IN` instead of the `WAIT` badge. The backoff is recorded against the *token* that failed (`authFailedToken`), so any later refresh that finds a **different** credential on file drops it and retries at once (`shouldClearAuthBackoff`) — the user signed in again, or Claude Code rotated the live entry. Never widen this to `rate`: a 429 is a verdict on the caller, and no amount of re-authenticating earns the quota back.
- **Idle gating** (`IDLE_THRESHOLD_MS`, `quotaPolicy.ts:8`; the gate is `autoTick`) — every automatic fetch, periodic or wake catch-up, checks `isClaudeIdle(20min)` against `~/.claude/projects/` mtime (`idle.ts`). If Claude Code itself hasn't been active in 20 minutes, the tick is skipped. Manual `refresh()` calls are unaffected.
- **Auto-refresh is refcounted, not configured.** `requestAutoRefresh(consumerId, ms)` / `releaseAutoRefresh(consumerId)` is the same acquire/release shape as `activeSessionService`, and both hosts default it **on**. Three properties fall out of it, and each one replaced a bug:
  - **It follows the account.** The registry re-points the timer on every `"changed"` and `"swapped"`, so it polls whoever is active *now*. There is deliberately no `enableAutoRefresh(null, …)` any more — resolving `null` once, at call time, armed the timer on a slug and left it polling the account the user swapped away from, and every host had to re-arm by hand to work around it.
  - **The tightest surviving request wins** (`resolveAutoInterval`). A view that wants no polling releases its own request; it cannot switch off a view that is still asking. Two quota keys where one had auto-refresh off used to mean neither polled, decided by whichever appeared last.
  - **`applyAutoRequests` is idempotent.** It runs on every account change, and `apps/desktop` re-reads the registry on every menu open, so re-arming a healthy timer each time would push the next tick out forever and nothing would ever poll.
  - **A view that appears with nothing to show fetches at once** (`primeNow`). Arming a timer is not enough: every process starts with an empty registry, so a plugin reload or a deck reconnect would draw `--%` until the first tick a quarter of an hour later. A **cold start** (no snapshot at all) deliberately skips the idle gate — a view appearing is a person launching an app, and it is one request per process. With a snapshot already in hand the gate applies again, and a snapshot fresher than the cadence costs nothing.
  - `enableAutoRefresh(slug, ms)` still exists for one fixed account. Cadence is clamped to ≥5 minutes either way.
- **Wake handling: `markAwake()` clears the 5s coalesce window and schedules one catch-up** (`WAKE_CATCHUP_DELAY_MS`, 5s), skipping any account with a request already in flight — clearing the coalesce window defeats the 5s floor, so a wake landing mid-request would otherwise spend a second one. Timers do not advance while the machine sleeps, so a 15-minute poll armed at midnight has not come due at breakfast — without the catch-up the menu bar would show last night's percentage until fifteen minutes of *awake* time had passed. It fires only for an account something is polling and only when the snapshot is already older than that cadence (`isSnapshotStale`), so a host that wants manual-only refresh keeps the old contract of spending no request on a wake. The 5s delay is what makes it safe: laptops resume into all sorts of network states.

## Multi-account architecture

`accountsService` (`accounts.ts`) maintains a registry on disk at `~/.config/siestadeck/accounts.json` plus per-account credential stashes in the keychain.

- **Every mutation goes through `mutateRegistry(fn)`** — it re-reads `accounts.json` from disk, applies `fn` to *that* document, and writes it back only if the fingerprint moved. Never mutate `this.registry` and call `writeRegistry` yourself: this package rewrites the whole document, so a write from a copy read earlier deletes whatever a second app added since. This is last-write-wins on purpose — it shrinks the lost-update window to one read-to-rename rather than eliminating it, which is the right trade when every mutation is a repeatable keypress and the alternative is a cross-process lock that can go stale. Calls are serialised on an in-process promise chain, so `fn` must not call `mutateRegistry` or `reload` (it would deadlock). Helpers a closure needs — `hasValidSelection`, `uniqueSlug`, `warnIfCrowded` — take the document as a parameter so a stale-read is a compile error rather than a review finding.
- **`reload()` is how a host picks up another process's writes** — re-reads and emits `"changed"` only when `registryFingerprint` actually differs. The suppression is load-bearing: `QuotaRegistry` answers `"changed"` by clearing auth backoffs and firing a network refresh, so an unconditional emit would spend an API call on every wake. It compares disk against `this.registry` rather than keeping a `lastFingerprint` field, because here `this.registry` *is* the record of what consumers were served.
- **Adoption on first run** (`accounts.ts:433-490`) — if Claude Code is already logged in to an account the plugin hasn't seen, copy those creds into a new account slug (using the email prefix as the display name) so the user doesn't have to re-auth.
- **New-login polling** (`accounts.ts:594-624`) — Login/Logout action spawns a Terminal running `claude auth login`; this method polls the keychain entry every 2s for ≤3 min, adopts whatever lands, emits `changed`. Used because there's no other signal that the OAuth flow finished.
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

## Sharing a machine with a second app

There are two consumers now — the Stream Deck plugin and the macOS menu bar app
(`apps/desktop`) — and the data they own is not process-local: `accounts.json`,
the credential stashes and the Anthropic rate limit are shared whenever both run.
What is already safe, and what is still deliberately not:

- **Registry writes re-read first.** `mutateRegistry` above. Last-write-wins, not atomic.
- **The Windows DPAPI cache re-validates against the file.** Entries are keyed by a hash of the ciphertext they came from (`credentialStore.ts`); a stale entry used to mean a spent refresh token, a 30-minute auth backoff and a `LOG IN` tile that never cleared. Deliberately not an mtime+size stamp: the write path cannot observe the file a second time without racing another writer between its own `writeFile` and that observation, which would pair our plaintext with their identity and produce an entry that matches forever. macOS has no such cache.
- **`reload()` is pull-only — nothing watches `accounts.json`.** Each host calls it at the moments it already treats as "we may have missed something": `plugin.ts` on wake and device-connect, `apps/desktop/src/main.ts` on wake and every time the menu is about to open. The menu-open call is why that app has no `tray.setContextMenu()` — a context menu is opened by macOS at the `NSStatusItem` level, which would take away the only hook that runs before it appears. A watcher is still the natural next step and belongs in the PR that needs it.
- **429 backoff is still per-process, on purpose.** Both apps independently obey the same 1→10min floor, so the worst case is 2× the request rate, self-healing, with nothing corrupted. That 2× is now real rather than hypothetical: both apps poll every 15 minutes by default, and both are idle-gated. A shared `quota-cache.json` is the most machinery for the least damage. `setBackoff()` / `clearBackoff()` in `quota.ts` are where that would wire in — two functions, not eight assignment sites.
- **Following the active account is the service's job, not the host's.** `requestAutoRefresh` re-points on `"changed"` and `"swapped"`, which is why neither host tracks an armed slug any more. `apps/desktop` used to carry an `armAutoRefresh()` for exactly this and the plugin carried the same bug unfixed; the note that used to live here saying "hosts that pass `null` must re-arm on `changed`" is what got folded into the service.
- **No locks, no daemon, no leader election.** Every field in play is monotone or idempotent, so a cross-process lock buys almost nothing and adds a stale-holder liveness problem that is strictly worse. A "designated fetcher" process is a daemon wearing a hat.

Still per-process and unexamined: `activeSession.ts`'s file watching (two apps
tailing the same JSONL is wasteful but not incorrect) and the `/profile` email
memo in `accounts.ts`.
