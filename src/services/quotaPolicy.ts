// Pure helpers extracted from QuotaRegistry. No I/O, no timers, no SDK refs —
// fully unit-testable. The class in quota.ts wires these into its state.

export const MIN_AUTO_POLL_MS = 5 * 60_000;
export const MIN_BACKOFF_MS = 60_000;
export const MAX_BACKOFF_MS = 10 * 60_000;
export const MIN_REFRESH_GAP_MS = 5_000;
export const IDLE_THRESHOLD_MS = 20 * 60_000;
export const UNAUTHORIZED_BACKOFF_MS = 30 * 60_000;

export type UsageWindow = { utilization: number; resets_at: string | null };

// One entry of the newer `limits` array. `kind` stays a plain string — the
// response body is an unvalidated cast (quota.ts), so a literal union would be
// false confidence about what the API actually sends.
export type UsageLimit = {
  kind: string; // "session" | "weekly_all" | "weekly_scoped" | future
  group?: string | null;
  percent: number | null;
  resets_at: string | null;
  severity?: string | null;
  scope?: { model?: { id: string | null; display_name: string | null } | null; surface?: unknown } | null;
  is_active?: boolean;
};

export type UsageResponse = {
  five_hour: UsageWindow;
  seven_day: UsageWindow;
  seven_day_opus?: UsageWindow | null;
  seven_day_sonnet?: UsageWindow | null;
  limits?: UsageLimit[] | null;
  extra_usage?: {
    is_enabled: boolean;
    monthly_limit: number | null;
    used_credits: number | null;
    utilization: number | null;
    currency: string | null;
  };
};

export type QuotaWindowSnapshot = { utilization: number; resetsAt: Date | null };

export type QuotaSnapshot = {
  slug: string | null;
  fiveHour: QuotaWindowSnapshot | null;
  sevenDay: QuotaWindowSnapshot | null;
  perModel: { opus?: QuotaWindowSnapshot; sonnet?: QuotaWindowSnapshot; fable?: QuotaWindowSnapshot };
  extraUsage?: {
    enabled: boolean;
    usedCredits: number | null;
    monthlyLimit: number | null;
    utilization: number | null;
    currency: string | null;
  };
  fetchedAt: Date;
  error?: string;
  cooldownUntil: Date | null;
  /**
   * Why we're cooling down, set only when cooldownUntil is. "auth" ⇒ the login
   * was lost (401/403 + failed refresh) and the tile should prompt re-login;
   * "rate" ⇒ a 429, which keeps the WAIT badge.
   */
  cooldownReason?: BackoffReason;
};

export function asWindow(w: UsageWindow | null | undefined): QuotaWindowSnapshot | null {
  if (!w) return null;
  return {
    utilization: w.utilization / 100,
    resetsAt: w.resets_at ? new Date(w.resets_at) : null,
  };
}

/**
 * Extract the Fable per-model weekly window from the `limits` array. The API
 * reports it as kind "weekly_scoped" with a model scope (the legacy
 * seven_day_opus/seven_day_sonnet fields now come back null). Prefer the entry
 * whose model display name matches /fable/i, falling back to the first
 * model-scoped weekly entry so a model rename degrades gracefully instead of
 * silently blanking the tile. Returns the raw UsageWindow shape so the 0-100 →
 * 0-1 normalization stays in asWindow.
 */
export function fableUsageWindowFromLimits(limits: UsageLimit[] | null | undefined): UsageWindow | null {
  if (!limits) return null;
  const scoped = limits.filter((l) => l.kind === "weekly_scoped" && l.scope?.model != null);
  const pick = scoped.find((l) => /fable/i.test(l.scope?.model?.display_name ?? "")) ?? scoped[0];
  if (!pick || typeof pick.percent !== "number") return null;
  return { utilization: pick.percent, resets_at: pick.resets_at ?? null };
}

export function buildSnapshot(
  slug: string | null,
  data: UsageResponse,
  now: Date = new Date(),
): QuotaSnapshot {
  return {
    slug,
    fiveHour: asWindow(data.five_hour),
    sevenDay: asWindow(data.seven_day),
    perModel: {
      opus: asWindow(data.seven_day_opus) ?? undefined, // legacy: the API now sends null
      sonnet: asWindow(data.seven_day_sonnet) ?? undefined, // legacy: the API now sends null
      fable: asWindow(fableUsageWindowFromLimits(data.limits)) ?? undefined,
    },
    extraUsage: data.extra_usage
      ? {
          enabled: data.extra_usage.is_enabled,
          usedCredits: data.extra_usage.used_credits,
          monthlyLimit: data.extra_usage.monthly_limit,
          utilization: data.extra_usage.utilization,
          currency: data.extra_usage.currency,
        }
      : undefined,
    fetchedAt: now,
    cooldownUntil: null,
  };
}

/**
 * Clamp a 429 retry-after hint (ms) into the configured backoff window.
 * Missing or sub-minimum hints round up to MIN_BACKOFF_MS; over-maximum
 * hints clamp down to MAX_BACKOFF_MS.
 */
export function computeBackoffMs(retryAfterMs: number | null | undefined): number {
  const hint = retryAfterMs && Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 0;
  return Math.min(Math.max(hint || MIN_BACKOFF_MS, MIN_BACKOFF_MS), MAX_BACKOFF_MS);
}

export function clampAutoInterval(intervalMs: number): number {
  if (intervalMs <= 0) return 0;
  return Math.max(intervalMs, MIN_AUTO_POLL_MS);
}

export type BackoffReason = "rate" | "auth";

/**
 * User-facing label for the WAIT countdown. `rate` means we got 429'd;
 * `auth` means the OAuth token expired and the refresh attempt failed.
 * Distinguishing the two avoids mislabelling a 401 backoff as a 429 when
 * the cached-snapshot is re-emitted mid-cooldown.
 */
export function backoffLabel(reason: BackoffReason | undefined, waitMs: number): string {
  const seconds = Math.max(1, Math.round(waitMs / 1000));
  return reason === "auth" ? `auth expired (wait ${seconds}s)` : `429 (wait ${seconds}s)`;
}

export type RefreshDecision = "fetch" | "coalesce" | "backoff" | "in-flight";

/**
 * Pure decision function for the refresh state machine. Given the current
 * per-account timers, return what the caller should do.
 */
export function decideRefresh(input: {
  now: number;
  lastAttemptAt: number;
  backoffUntil: number;
  inFlight: boolean;
}): RefreshDecision {
  if (input.inFlight) return "in-flight";
  if (input.now < input.backoffUntil) return "backoff";
  if (input.now - input.lastAttemptAt < MIN_REFRESH_GAP_MS) return "coalesce";
  return "fetch";
}
