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
  shouldClearAuthBackoff,
  UNAUTHORIZED_BACKOFF_MS,
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
  /**
   * Configured auto-refresh cadence in ms (already clamped to MIN_AUTO_POLL_MS).
   * Set by enableAutoRefresh and remembered across suspend/resume so that
   * pausing on device-disconnect doesn't forget the user's setting.
   * 0 means "auto-refresh disabled".
   */
  autoIntervalMs: number;
};

/**
 * Per-account quota fetcher.
 *
 * Policy:
 *  - **No polling by default.** Auto-refresh is off; the only way the plugin
 *    talks to Anthropic is when an action explicitly asks (`refresh()`).
 *  - **Per-account 5s floor.** Two refresh calls within 5s for the same
 *    account are coalesced; the second returns the cached snapshot.
 *  - **429 backoff.** A 429 response sets a per-account `backoffUntil`
 *    timestamp (1 → 10 minutes); refresh attempts within that window return
 *    the cached snapshot without hitting the network.
 *  - **401/403 backoff.** An auth failure sets a 30-minute `backoffUntil`
 *    so we don't keep hammering Anthropic with a stale token and earn an
 *    actual 429.
 *  - **Opt-in auto-refresh.** `enableAutoRefresh(slug, ms)` schedules a
 *    timer with a 5-minute minimum cadence.
 */
export class QuotaRegistry extends EventEmitter {
  private accounts = new Map<string, AccountState>();

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
          s.backoffUntil = 0;
          s.backoffReason = undefined;
          s.authFailedToken = undefined;
          s.lastAttemptAt = 0;
          recovered = true;
        }
      }
      this.sync();
      if (recovered) void this.refresh();
    });
    accountsService.on("swapped", (slug: string) => {
      const state = this.accounts.get(slug);
      if (!state) return;
      if (state.latest) this.publish(state, state.latest);
      state.lastAttemptAt = 0;
      void this.refresh(slug);
    });
  }

  stop(): void {
    for (const s of this.accounts.values()) {
      if (s.autoTimer) clearTimeout(s.autoTimer);
    }
    this.accounts.clear();
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
          state.backoffUntil = now + wait;
          state.backoffReason = "rate";
          this.publishError(state, backoffLabel("rate", wait), state.backoffUntil);
        } else if (result.status === 401 || result.status === 403) {
          // Stale/expired OAuth token. Try refreshing once via the stashed
          // refresh_token; if that works, retry the usage fetch with the
          // fresh access token. If anything fails, cool down for 30 min so
          // repeated auto-polls don't trip Anthropic's WAF.
          const { recovered, lastToken } = await this.tryRefreshAndRetry(state, token);
          if (!recovered) {
            state.backoffUntil = now + UNAUTHORIZED_BACKOFF_MS;
            state.backoffReason = "auth";
            state.authFailedToken = lastToken;
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
        state.backoffUntil = 0;
        state.backoffReason = undefined;
        state.authFailedToken = undefined;
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
    state.backoffUntil = 0;
    state.backoffReason = undefined;
    state.authFailedToken = undefined;
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
      state.backoffUntil = 0;
      state.backoffReason = undefined;
      state.authFailedToken = undefined;
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
   * Enable auto-refresh for a given account. Cadence is clamped to 5min+.
   * Pass 0 to disable.
   */
  enableAutoRefresh(slug: string | null, intervalMs: number): void {
    const resolved = slug ?? accountsService.activeSlug;
    if (!resolved) return;
    const state = this.accounts.get(resolved);
    if (!state) return;
    if (state.autoTimer) clearTimeout(state.autoTimer);
    state.autoTimer = undefined;
    state.autoIntervalMs = clampAutoInterval(intervalMs);
    if (state.autoIntervalMs === 0) return;
    this.armAutoTimer(state);
  }

  private armAutoTimer(state: AccountState): void {
    if (!state.autoIntervalMs) return;
    if (state.autoTimer) clearTimeout(state.autoTimer);
    const interval = state.autoIntervalMs;
    const tick = async () => {
      if (await isClaudeIdle(IDLE_THRESHOLD_MS)) {
        log().debug(`quota[${state.slug}]: idle, skipping auto tick`);
      } else {
        void this.refresh(state.slug);
      }
      state.autoTimer = setTimeout(() => void tick(), interval);
      state.autoTimer.unref();
    };
    state.autoTimer = setTimeout(() => void tick(), interval);
    state.autoTimer.unref();
  }

  /**
   * Pause all running auto-refresh timers but remember their configured
   * intervals. Call when the last Stream Deck device disconnects (no human
   * is looking at the deck).
   */
  suspendAuto(): void {
    for (const state of this.accounts.values()) {
      if (state.autoTimer) {
        clearTimeout(state.autoTimer);
        state.autoTimer = undefined;
      }
    }
  }

  /**
   * Re-arm auto-refresh timers using each account's remembered interval.
   * Call when a Stream Deck device reconnects.
   */
  resumeAuto(): void {
    for (const state of this.accounts.values()) this.armAutoTimer(state);
  }

  /**
   * Clear the per-account 5s coalesce window so the first refresh after
   * system wake isn't suppressed. Does not perform any network calls.
   */
  markAwake(): void {
    for (const state of this.accounts.values()) state.lastAttemptAt = 0;
  }

  private sync(): void {
    const accounts = accountsService.list();
    const wanted = new Set(accounts.map((a) => a.slug));
    for (const [slug, state] of this.accounts.entries()) {
      if (!wanted.has(slug)) {
        if (state.autoTimer) clearTimeout(state.autoTimer);
        this.accounts.delete(slug);
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
    const snap: QuotaSnapshot = {
      slug: state.slug,
      fiveHour: state.latest?.fiveHour ?? null,
      sevenDay: state.latest?.sevenDay ?? null,
      perModel: state.latest?.perModel ?? {},
      extraUsage: state.latest?.extraUsage,
      fetchedAt: new Date(),
      error,
      cooldownUntil: cooldownUntilMs ? new Date(cooldownUntilMs) : null,
      cooldownReason: cooldownUntilMs != null ? state.backoffReason : undefined,
    };
    state.latest = snap;
    this.publish(state, snap);
  }
}

export const quotaRegistry = new QuotaRegistry();
