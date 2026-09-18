import { EventEmitter } from "node:events";

import { readClaudeCredentials } from "./keychain.js";
import { accountsService } from "./accounts.js";
import { isClaudeIdle } from "./idle.js";
import { log } from "./log.js";
import {
  backoffLabel,
  buildSnapshot,
  clampAutoInterval,
  computeBackoffMs,
  decideRefresh,
  IDLE_THRESHOLD_MS,
  isSnapshotStale,
  resolveAutoInterval,
  shouldClearAuthBackoff,
  UNAUTHORIZED_BACKOFF_MS,
  WAKE_CATCHUP_DELAY_MS,
  type BackoffReason,
  type QuotaSnapshot,
  type QuotaWindowSnapshot,
  type UsageResponse,
} from "./quotaPolicy.js";

export type { QuotaSnapshot, QuotaWindowSnapshot } from "./quotaPolicy.js";

const ENDPOINT = "https://api.anthropic.com/api/oauth/usage";

type TokenSource = () => Promise<string>;

async function fetchUsage(token: string): Promise<UsageResponse | { status: number; retryAfter?: number }> {
  const res = await fetch(ENDPOINT, {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
  });
  if (res.status === 429) {
    return { status: 429, retryAfter: Number(res.headers.get("retry-after")) * 1000 };
  }
  if (!res.ok) return { status: res.status };
  return (await res.json()) as UsageResponse;
}

type AccountState = {
  slug: string;
  tokenSource: TokenSource;
  latest?: QuotaSnapshot;
  inFlight: boolean;
  lastAttemptAt: number;
  backoffUntil: number;
  backoffReason?: BackoffReason;
  /**
   * The access token an "auth" backoff was recorded against, so a later refresh
   * can tell "the login is still lost" from "a new credential has landed since".
   * Unset for every other backoff reason and cleared on every success.
   */
  authFailedToken?: string;
  autoTimer?: NodeJS.Timeout;
  /** The one-shot catch-up scheduled by markAwake(). */
  wakeTimer?: NodeJS.Timeout;
  /**
   * Configured auto-refresh cadence in ms (already clamped to MIN_AUTO_POLL_MS).
   * Set by enableAutoRefresh / requestAutoRefresh and remembered across
   * suspend/resume so that pausing on device-disconnect doesn't forget the
   * user's setting. 0 means "auto-refresh disabled".
   */
  autoIntervalMs: number;
};

/**
 * Per-account quota fetcher.
 *
 * Policy:
 *  - **Nothing polls until a view asks.** `requestAutoRefresh(id, ms)` is how a
 *    view says "keep the active account current while I'm on screen";
 *    `releaseAutoRefresh(id)` withdraws it, and the last withdrawal stops the
 *    polling. Hosts default it on — a readout that is only right just after you
 *    press it isn't a readout — but the service itself starts silent.
 *  - **Per-account 5s floor.** Two refresh calls within 5s for the same
 *    account are coalesced; the second returns the cached snapshot. This is the
 *    throttle on a user hammering a key, and on a host that refreshes on every
 *    menu open.
 *  - **429 backoff.** A 429 response sets a per-account `backoffUntil`
 *    timestamp (1 → 10 minutes); refresh attempts within that window return
 *    the cached snapshot without hitting the network.
 *  - **401/403 backoff.** An auth failure sets a 30-minute `backoffUntil`
 *    so we don't keep hammering Anthropic with a stale token and earn an
 *    actual 429.
 *  - **Idle gating.** An auto tick spends no request when Claude Code itself
 *    has been quiet for 20 minutes. Manual `refresh()` calls are unaffected.
 *  - **5-minute cadence floor**, whatever any host asks for.
 */
export class QuotaRegistry extends EventEmitter {
  private accounts = new Map<string, AccountState>();

  /**
   * Cadence, in ms, requested per live view — see `requestAutoRefresh`. The
   * tightest one wins, and an empty map means nothing polls.
   */
  private autoRequests = new Map<string, number>();

  /**
   * The slug those requests are currently armed on, so a swap can stand the old
   * account's timer down. Not derivable from `accountsService.activeSlug`: by
   * the time we hear about a swap, that getter already returns the new account.
   */
  private autoArmedSlug: string | null = null;

  /**
   * Set by `suspendAuto()`. Checked by every arming path, so a request or an
   * account change arriving while no UI is watching cannot quietly restart the
   * polling that suspend just stopped.
   */
  private suspended = false;

  /**
   * Park `state` until `until`, recording why.
   *
   * `token` is only meaningful for `"auth"`: it is the credential the verdict
   * was passed on, so a later refresh can tell "the login is still lost" from
   * "a new credential has landed since". A `"rate"` backoff clears it, because
   * a 429 says nothing about the credential and leaving a stale token behind
   * would let `shouldClearAuthBackoff` read it later as evidence.
   *
   * Does not publish. Callers publish after, so the snapshot they build sees
   * the reason this just set.
   */
  private setBackoff(
    state: AccountState,
    until: number,
    reason: BackoffReason,
    token?: string,
  ): void {
    state.backoffUntil = until;
    state.backoffReason = reason;
    state.authFailedToken = reason === "auth" ? token : undefined;
  }

  /**
   * Drop any backoff on `state`.
   *
   * `resetAttempt` additionally zeroes `lastAttemptAt`, which defeats the 5s
   * coalesce floor so a refresh issued right afterwards actually reaches the
   * network. Exactly one caller wants that — the re-login path, where the whole
   * point is to get the gauge back within a couple of seconds — so it is a
   * named argument rather than a default. Turning it on everywhere would
   * quietly delete the coalescing that stops a double-press becoming two
   * requests.
   */
  private clearBackoff(state: AccountState, opts: { resetAttempt?: boolean } = {}): void {
    state.backoffUntil = 0;
    state.backoffReason = undefined;
    state.authFailedToken = undefined;
    if (opts.resetAttempt) state.lastAttemptAt = 0;
  }

  start(): void {
    this.sync();
    accountsService.on("changed", () => {
      // A re-login (Login action, or a press on a logged-out quota tile) adopts
      // fresh creds and emits "changed" without altering the slug set, so
      // sync() alone would leave the stale 30-min auth backoff in place and the
      // tile stuck on "LOG IN". Clear *auth* backoffs (never a real 429) and
      // refresh so the gauge returns within a couple of seconds.
      let recovered = false;
      for (const s of this.accounts.values()) {
        if (s.backoffReason === "auth") {
          // resetAttempt: without it the refresh below lands inside the 5s
          // coalesce window and the tile stays on LOG IN after a good re-login.
          this.clearBackoff(s, { resetAttempt: true });
          recovered = true;
        }
      }
      this.sync();
      if (recovered) void this.refresh();
    });
    accountsService.on("swapped", (slug: string) => {
      // Move the polling to the account that is now active before anything
      // else: "swapped" does not go through sync(), so this is the only hook
      // that stops us polling the account the user just left.
      this.applyAutoRequests();
      const state = this.accounts.get(slug);
      if (!state) return;
      if (state.latest) this.publish(state, state.latest);
      state.lastAttemptAt = 0;
      void this.refresh(slug);
    });
  }

  stop(): void {
    for (const s of this.accounts.values()) this.disarmAuto(s);
    this.accounts.clear();
    this.autoRequests.clear();
    this.autoArmedSlug = null;
  }

  /**
   * Returns the most recent snapshot for the given slug (or the active
   * account if slug is null). No network call. If nothing has been
   * fetched yet for that account, returns undefined.
   */
  snapshotFor(slug: string | null): QuotaSnapshot | undefined {
    const resolvedSlug = slug ?? accountsService.activeSlug;
    if (!resolvedSlug) return undefined;
    const snap = this.accounts.get(resolvedSlug)?.latest;
    if (!snap) return undefined;
    // For "active" subscribers, return a copy with slug=null so they can
    // recognise it as the active alias.
    return slug ? snap : { ...snap, slug: null };
  }

  /**
   * Trigger one refresh for the given slug (or the active account if
   * undefined). Coalesces rapid repeat calls and respects 429 backoff.
   * Returns the post-refresh snapshot.
   */
  async refresh(slug?: string): Promise<QuotaSnapshot | undefined> {
    const resolved = slug ?? accountsService.activeSlug;
    if (!resolved) return undefined;
    const state = this.accounts.get(resolved);
    if (!state) return undefined;
    const now = Date.now();
    const decision = decideRefresh({
      now,
      lastAttemptAt: state.lastAttemptAt,
      backoffUntil: state.backoffUntil,
      inFlight: state.inFlight,
    });
    if (decision === "in-flight") return state.latest;
    // Set when a stale auth backoff was dropped below; carried into the fetch so
    // the credential isn't resolved twice.
    let token: string | undefined;
    if (decision === "backoff") {
      token = (await this.tokenIfAuthBackoffIsStale(state)) ?? undefined;
      if (token == null) {
        this.publishError(
          state,
          backoffLabel(state.backoffReason, state.backoffUntil - now),
          state.backoffUntil,
        );
        return state.latest;
      }
    }
    if (decision === "coalesce") return state.latest;
    state.inFlight = true;
    state.lastAttemptAt = now;
    try {
      token ??= await state.tokenSource();
      const result = await fetchUsage(token);
      if ("status" in result) {
        if (result.status === 429) {
          const wait = computeBackoffMs(result.retryAfter);
          this.setBackoff(state, now + wait, "rate");
          this.publishError(state, backoffLabel("rate", wait), state.backoffUntil);
        } else if (result.status === 401 || result.status === 403) {
          // Stale/expired OAuth token. Try refreshing once via the stashed
          // refresh_token; if that works, retry the usage fetch with the
          // fresh access token. If anything fails, cool down for 30 min so
          // repeated auto-polls don't trip Anthropic's WAF.
          const { recovered, lastToken } = await this.tryRefreshAndRetry(state, token);
          if (!recovered) {
            this.setBackoff(state, now + UNAUTHORIZED_BACKOFF_MS, "auth", lastToken);
            this.publishError(
              state,
              `auth expired (${result.status})`,
              state.backoffUntil,
            );
          }
        } else {
          this.publishError(state, `HTTP ${result.status}`);
        }
      } else {
        this.clearBackoff(state);
        const snap = buildSnapshot(state.slug, result);
        state.latest = snap;
        this.publish(state, snap);
      }
    } catch (err) {
      this.publishError(state, err instanceof Error ? err.message : String(err));
    } finally {
      state.inFlight = false;
    }
    return state.latest;
  }

  /**
   * The account's current token, but only when an in-force auth backoff no
   * longer describes it — the credential on file has changed since the failure.
   * Clears the backoff as a side effect and hands the token back so the caller
   * can fetch with it; returns null to leave the backoff standing.
   *
   * Resolving the token is a local credential-store read (plus, at most, one
   * memoized `/profile` identity check), never a usage request — so this cannot
   * dig the rate-limit hole deeper. The alternative is telling the user to sign
   * in again when they already have.
   */
  private async tokenIfAuthBackoffIsStale(state: AccountState): Promise<string | null> {
    if (state.backoffReason !== "auth") return null; // a 429 must run its course
    let current: string | null;
    try {
      current = await state.tokenSource();
    } catch {
      return null; // no credential at all — the login really is gone
    }
    const stale = shouldClearAuthBackoff({
      backoffReason: state.backoffReason,
      backoffToken: state.authFailedToken,
      currentToken: current,
    });
    if (!stale) return null;
    this.clearBackoff(state);
    log().info(`quota[${state.slug}]: new credential on file — dropping auth backoff`);
    return current;
  }

  /**
   * Attempt to mint a fresh OAuth token for this account via
   * `accountsService.refreshTokenFor` and retry the usage fetch once. On
   * success, publishes the new snapshot and reports `recovered`. On failure
   * (missing refresh_token, refresh endpoint rejects, retry still errors), the
   * caller is expected to back off.
   *
   * `lastToken` is the token the backoff should be recorded against: the freshly
   * minted one when a mint happened, `failedToken` otherwise. Reporting the
   * pre-mint token would make the account look re-credentialled to
   * `tokenIfAuthBackoffIsStale` on the very next press, which would retry
   * forever instead of backing off.
   *
   * Runs inside the outer `inFlight=true` block, so concurrent refreshes
   * for the same slug are already serialised.
   */
  private async tryRefreshAndRetry(
    state: AccountState,
    failedToken: string,
  ): Promise<{ recovered: boolean; lastToken: string }> {
    if (state.slug === "__bootstrap__") return { recovered: false, lastToken: failedToken };
    const ok = await accountsService.refreshTokenFor(state.slug);
    if (!ok) return { recovered: false, lastToken: failedToken };
    let token: string;
    try {
      token = await state.tokenSource();
    } catch {
      return { recovered: false, lastToken: failedToken };
    }
    try {
      const result = await fetchUsage(token);
      if ("status" in result) return { recovered: false, lastToken: token };
      this.clearBackoff(state);
      const snap = buildSnapshot(state.slug, result);
      state.latest = snap;
      this.publish(state, snap);
      log().info(`quota[${state.slug}]: refreshed OAuth token`);
      return { recovered: true, lastToken: token };
    } catch {
      return { recovered: false, lastToken: token };
    }
  }

  /**
   * Keep the **active** account polled every `intervalMs` while `consumerId` is
   * on screen. Reference-counted like `activeSessionService.acquire()`: call it
   * from the moment a view appears, `releaseAutoRefresh` when it goes away, and
   * the last release stops the polling.
   *
   * Two things this buys over arming a timer per view:
   *
   * 1. **It follows the account.** The registry re-arms on every `"changed"`
   *    and `"swapped"`, so the timer polls whoever is active now. A host that
   *    armed a slug directly kept polling the account the user swapped away
   *    from, and every host had to re-arm by hand to work around it.
   * 2. **One view cannot silence another.** The tightest surviving request wins
   *    (`resolveAutoInterval`), so turning auto-refresh off on one key stops
   *    that key asking — not the polling that a second key still wants.
   *
   * `intervalMs` is clamped to the 5-minute floor; 0 is the same as releasing.
   */
  requestAutoRefresh(consumerId: string, intervalMs: number): void {
    if (intervalMs > 0) this.autoRequests.set(consumerId, intervalMs);
    else this.autoRequests.delete(consumerId);
    this.applyAutoRequests();
  }

  /** Withdraw `consumerId`'s cadence request. See `requestAutoRefresh`. */
  releaseAutoRefresh(consumerId: string): void {
    if (!this.autoRequests.delete(consumerId)) return;
    this.applyAutoRequests();
  }

  /**
   * Point the requested cadence at whichever account is active now.
   *
   * Idempotent on purpose — it runs on every account change, and re-arming a
   * timer that is already running at the right cadence would push the next tick
   * out by a full interval each time, so a host that emits `"changed"` often
   * would never poll at all.
   */
  private applyAutoRequests(): void {
    const interval = resolveAutoInterval(this.autoRequests.values());
    const target = interval > 0 ? accountsService.activeSlug : null;
    if (this.autoArmedSlug && this.autoArmedSlug !== target) {
      const previous = this.accounts.get(this.autoArmedSlug);
      if (previous) this.disarmAuto(previous);
    }
    this.autoArmedSlug = target;
    if (!target) return;
    const state = this.accounts.get(target);
    if (!state) {
      // The account exists in the registry but not here yet; sync() will call
      // us again once it does. Forget the slug so that call re-arms.
      this.autoArmedSlug = null;
      return;
    }
    if (state.autoIntervalMs === interval && state.autoTimer) return;
    state.autoIntervalMs = interval;
    this.armAutoTimer(state);
  }

  /**
   * Enable auto-refresh for one named account, independently of what the views
   * have asked for. Cadence is clamped to 5min+; pass 0 to disable.
   *
   * Prefer `requestAutoRefresh` — a host almost always means "the account the
   * user is looking at", which is not a slug but a question re-answered on
   * every swap. This is the primitive underneath, kept for a host that really
   * does mean one fixed account.
   */
  enableAutoRefresh(slug: string, intervalMs: number): void {
    const state = this.accounts.get(slug);
    if (!state) return;
    state.autoIntervalMs = clampAutoInterval(intervalMs);
    this.armAutoTimer(state);
  }

  private armAutoTimer(state: AccountState): void {
    if (state.autoTimer) clearTimeout(state.autoTimer);
    state.autoTimer = undefined;
    if (!state.autoIntervalMs || this.suspended) return;
    const interval = state.autoIntervalMs;
    const tick = async () => {
      await this.autoTick(state);
      state.autoTimer = setTimeout(() => void tick(), interval);
      state.autoTimer.unref();
    };
    state.autoTimer = setTimeout(() => void tick(), interval);
    state.autoTimer.unref();
  }

  /**
   * One automatic fetch, gated on Claude Code actually being in use. Shared by
   * the periodic timer and the wake catch-up so that "we don't poll for a
   * machine nobody is coding on" holds for both.
   */
  private async autoTick(state: AccountState): Promise<void> {
    if (await isClaudeIdle(IDLE_THRESHOLD_MS)) {
      log().debug(`quota[${state.slug}]: idle, skipping auto tick`);
      return;
    }
    void this.refresh(state.slug);
  }

  /** Stop every timer on `state` and forget its cadence. */
  private disarmAuto(state: AccountState): void {
    if (state.autoTimer) clearTimeout(state.autoTimer);
    state.autoTimer = undefined;
    if (state.wakeTimer) clearTimeout(state.wakeTimer);
    state.wakeTimer = undefined;
    state.autoIntervalMs = 0;
  }

  /**
   * Pause all running auto-refresh timers but remember their configured
   * intervals. Call when no UI is observing any more — e.g. the last Stream
   * Deck device disconnects, or a tray window closes.
   */
  suspendAuto(): void {
    this.suspended = true;
    for (const state of this.accounts.values()) {
      if (state.autoTimer) {
        clearTimeout(state.autoTimer);
        state.autoTimer = undefined;
      }
      if (state.wakeTimer) {
        clearTimeout(state.wakeTimer);
        state.wakeTimer = undefined;
      }
    }
  }

  /**
   * Re-arm auto-refresh timers using each account's remembered interval.
   * Call when a UI starts observing again — e.g. a Stream Deck device
   * reconnects.
   */
  resumeAuto(): void {
    this.suspended = false;
    for (const state of this.accounts.values()) this.armAutoTimer(state);
  }

  /**
   * Tell the registry the machine just woke. Clears the per-account 5s coalesce
   * window so a press right after wake isn't suppressed, and schedules one
   * catch-up fetch per polled account whose snapshot is already older than its
   * own cadence.
   *
   * The catch-up exists because timers don't advance while the machine sleeps:
   * a 15-minute poll armed at midnight has not come due at breakfast, so
   * without this the menu bar would show last night's percentage until fifteen
   * minutes of *awake* time had passed. It waits `WAKE_CATCHUP_DELAY_MS` for the
   * network to come back, and goes through the same idle gate as a normal tick.
   *
   * Nothing is fetched for an account no view is polling — a host that wants
   * manual-only refresh still spends no request on a wake.
   */
  markAwake(): void {
    const now = Date.now();
    for (const state of this.accounts.values()) {
      state.lastAttemptAt = 0;
      const stale = isSnapshotStale({
        now,
        fetchedAt: state.latest?.fetchedAt.getTime(),
        intervalMs: state.autoIntervalMs,
      });
      if (!stale || this.suspended) continue;
      if (state.wakeTimer) clearTimeout(state.wakeTimer);
      state.wakeTimer = setTimeout(() => {
        state.wakeTimer = undefined;
        // Re-arm from here rather than leaving a timer that believes it is
        // mid-interval: this tick is the interval's new starting point.
        this.armAutoTimer(state);
        void this.autoTick(state);
      }, WAKE_CATCHUP_DELAY_MS);
      state.wakeTimer.unref();
    }
  }

  private sync(): void {
    const accounts = accountsService.list();
    const wanted = new Set(accounts.map((a) => a.slug));
    for (const [slug, state] of this.accounts.entries()) {
      if (!wanted.has(slug)) {
        this.disarmAuto(state);
        this.accounts.delete(slug);
        // Removed out from under the poller: forget it, so the re-arm at the
        // end of this method treats the new active account as a fresh target.
        if (this.autoArmedSlug === slug) this.autoArmedSlug = null;
      }
    }
    for (const acct of accounts) {
      if (this.accounts.has(acct.slug)) continue;
      const slug = acct.slug;
      this.accounts.set(slug, {
        slug,
        tokenSource: async () => {
          const t = await accountsService.getAccessToken(slug);
          if (!t) throw new Error(`No stored token for ${slug}`);
          return t;
        },
        inFlight: false,
        lastAttemptAt: 0,
        backoffUntil: 0,
        autoIntervalMs: 0,
      });
    }
    // If we somehow have zero saved accounts but Claude Code is logged in,
    // fall back to a synthetic state that reads the live keychain entry.
    if (this.accounts.size === 0) {
      const slug = "__bootstrap__";
      this.accounts.set(slug, {
        slug,
        tokenSource: async () => (await readClaudeCredentials()).claudeAiOauth.accessToken,
        inFlight: false,
        lastAttemptAt: 0,
        backoffUntil: 0,
        autoIntervalMs: 0,
      });
    }
    // Last, and here rather than at the two call sites: every path that changes
    // which accounts exist ends up in sync(), and a view's cadence request has
    // to reach whatever the active account turned out to be — including one
    // adopted seconds ago, which is why this runs after the loop above.
    this.applyAutoRequests();
  }

  private publish(state: AccountState, snap: QuotaSnapshot): void {
    this.emit(`snapshot:${state.slug}`, snap);
    this.emit("snapshot", snap);
    if (accountsService.activeSlug === state.slug) {
      const aliased = { ...snap, slug: null };
      this.emit("snapshot:active", aliased);
      this.emit("snapshot", aliased);
    }
  }

  private publishError(state: AccountState, error: string, cooldownUntilMs?: number): void {
    // One predicate for both fields. They used to disagree — truthiness for the
    // timestamp, nullish for the reason — so a cooldownUntilMs of 0 would have
    // published a null cooldown with a populated reason, and the tile reads the
    // reason on its own in one place. No caller passes 0 today; the point is
    // that the snapshot cannot describe a cooldown that isn't there.
    const cooling = cooldownUntilMs != null && cooldownUntilMs > 0;
    const snap: QuotaSnapshot = {
      slug: state.slug,
      fiveHour: state.latest?.fiveHour ?? null,
      sevenDay: state.latest?.sevenDay ?? null,
      perModel: state.latest?.perModel ?? {},
      extraUsage: state.latest?.extraUsage,
      fetchedAt: new Date(),
      error,
      cooldownUntil: cooling ? new Date(cooldownUntilMs) : null,
      cooldownReason: cooling ? state.backoffReason : undefined,
    };
    state.latest = snap;
    this.publish(state, snap);
  }
}

export const quotaRegistry = new QuotaRegistry();
