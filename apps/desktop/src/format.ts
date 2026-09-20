/**
 * Presentation helpers for the menu bar.
 *
 * Deliberately not shared with the Stream Deck plugin. `formatResetTime()` in
 * apps/streamdeck/src/render/svg.ts is tuned for a 144px tile: it compresses a
 * reset to "1:15", which is indistinguishable from a clock time, and collapses
 * anything past a day to whole days. A menu row is as wide as its longest
 * sibling, so it can afford to say what it means.
 */

/** Shown wherever a number exists in the layout but not yet in the data. */
export const UNKNOWN = "—";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * `QuotaWindowSnapshot.utilization` is 0..1 — core normalizes the API's 0–100
 * in quotaPolicy.ts. Values at or past 1 are real (the window is spent), so
 * they round to "100%" rather than being clamped away.
 */
export function formatPercent(utilization: number | null | undefined): string {
  if (utilization == null || !Number.isFinite(utilization)) return UNKNOWN;
  return `${Math.round(utilization * 100)}%`;
}

/** Whole seconds between now and a future instant; 0 once it has passed. */
function secondsUntil(target: Date | null | undefined, now: Date): number {
  if (target == null) return 0;
  const ms = target.getTime() - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.floor(ms / 1000);
}

/**
 * How long until a quota window rolls over, at the coarsest granularity that is
 * still honest: "2d 3h", "1h 15m", "42m", "under a minute". Returns "" once the
 * reset is in the past or unknown, so the caller can drop the clause entirely
 * rather than print a contradiction.
 */
export function formatResetsIn(resetsAt: Date | null | undefined, now: Date): string {
  const total = secondsUntil(resetsAt, now);
  if (total === 0) return "";
  if (total < MINUTE) return "under a minute";

  if (total >= DAY) {
    const days = Math.floor(total / DAY);
    const hours = Math.floor((total % DAY) / HOUR);
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (total >= HOUR) {
    const hours = Math.floor(total / HOUR);
    const minutes = Math.floor((total % HOUR) / MINUTE);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${Math.floor(total / MINUTE)}m`;
}

/**
 * A rate-limit cooldown, which is short enough that seconds matter: "47s",
 * "3m 20s". Separate from formatResetsIn because "under a minute" is useless
 * advice when the whole wait is under a minute.
 */
export function formatWait(until: Date | null | undefined, now: Date): string {
  const total = secondsUntil(until, now);
  if (total === 0) return "";
  if (total < MINUTE) return `${total}s`;
  const minutes = Math.floor(total / MINUTE);
  const seconds = total % MINUTE;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}
