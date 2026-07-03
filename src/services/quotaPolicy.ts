// Pure helpers extracted from QuotaRegistry. No I/O, no timers, no SDK refs —
// fully unit-testable. The class in quota.ts wires these into its state.

export const MIN_AUTO_POLL_MS = 5 * 60_000;
export const MIN_BACKOFF_MS = 60_000;
export const MAX_BACKOFF_MS = 10 * 60_000;
export const MIN_REFRESH_GAP_MS = 5_000;
export const IDLE_THRESHOLD_MS = 20 * 60_000;
export const UNAUTHORIZED_BACKOFF_MS = 30 * 60_000;

export type UsageWindow = { utilization: number; resets_at: string | null };
export type UsageResponse = {
  five_hour: UsageWindow;
  seven_day: UsageWindow;
  seven_day_opus?: UsageWindow | null;
  seven_day_sonnet?: UsageWindow | null;
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
  perModel: { opus?: QuotaWindowSnapshot; sonnet?: QuotaWindowSnapshot };
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
      opus: asWindow(data.seven_day_opus) ?? undefined,
      sonnet: asWindow(data.seven_day_sonnet) ?? undefined,
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
