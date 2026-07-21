import { describe, expect, it } from "vitest";

import {
  asWindow,
  backoffLabel,
  buildSnapshot,
  clampAutoInterval,
  computeBackoffMs,
  decideRefresh,
  fableUsageWindowFromLimits,
  MAX_BACKOFF_MS,
  MIN_AUTO_POLL_MS,
  MIN_BACKOFF_MS,
  MIN_REFRESH_GAP_MS,
  type UsageLimit,
} from "./quotaPolicy.js";

// Shape captured from the live /api/oauth/usage endpoint (2026-07-21). The
// Fable weekly bucket rides the `limits` array as kind "weekly_scoped" with a
// model scope; the legacy seven_day_opus/seven_day_sonnet fields are null.
const LIVE_LIMITS: UsageLimit[] = [
  { kind: "session", group: "session", percent: 52, severity: "normal", resets_at: "2026-07-21T19:30:00.337054+00:00", scope: null, is_active: false },
  { kind: "weekly_all", group: "weekly", percent: 63, severity: "normal", resets_at: "2026-07-24T07:00:00.337077+00:00", scope: null, is_active: false },
  {
    kind: "weekly_scoped",
    group: "weekly",
    percent: 77,
    severity: "warning",
    resets_at: "2026-07-24T07:00:00.337368+00:00",
    scope: { model: { id: null, display_name: "Fable" }, surface: null },
    is_active: true,
  },
];

describe("asWindow", () => {
  it("returns null for missing input", () => {
    expect(asWindow(null)).toBeNull();
    expect(asWindow(undefined)).toBeNull();
  });

  it("converts percent-utilization to a 0-1 ratio", () => {
    expect(asWindow({ utilization: 42, resets_at: null })?.utilization).toBeCloseTo(0.42, 6);
    expect(asWindow({ utilization: 100, resets_at: null })?.utilization).toBe(1);
    expect(asWindow({ utilization: 0, resets_at: null })?.utilization).toBe(0);
  });

  it("parses the resets_at string into a Date when present", () => {
    const iso = "2026-05-11T12:00:00.000Z";
    const w = asWindow({ utilization: 10, resets_at: iso });
    expect(w?.resetsAt).toBeInstanceOf(Date);
    expect(w?.resetsAt?.toISOString()).toBe(iso);
  });

  it("leaves resetsAt null when resets_at is null", () => {
    expect(asWindow({ utilization: 10, resets_at: null })?.resetsAt).toBeNull();
  });
});

describe("fableUsageWindowFromLimits", () => {
  it("picks the model-scoped weekly entry from the live payload shape", () => {
    const w = fableUsageWindowFromLimits(LIVE_LIMITS);
    expect(w).toEqual({ utilization: 77, resets_at: "2026-07-24T07:00:00.337368+00:00" });
    // The microsecond +00:00 timestamps parse into valid Dates via asWindow.
    const snap = asWindow(w);
    expect(snap?.utilization).toBeCloseTo(0.77, 6);
    expect(snap?.resetsAt).toBeInstanceOf(Date);
    expect(snap?.resetsAt?.toISOString()).toBe("2026-07-24T07:00:00.337Z");
  });

  it("returns null when limits is missing (older API responses)", () => {
    expect(fableUsageWindowFromLimits(null)).toBeNull();
    expect(fableUsageWindowFromLimits(undefined)).toBeNull();
    expect(fableUsageWindowFromLimits([])).toBeNull();
  });

  it("returns null when no weekly_scoped entry exists", () => {
    expect(fableUsageWindowFromLimits(LIVE_LIMITS.slice(0, 2))).toBeNull();
  });

  it("ignores weekly_scoped entries without a model scope", () => {
    const noModel: UsageLimit[] = [
      { kind: "weekly_scoped", percent: 80, resets_at: null, scope: null },
      { kind: "weekly_scoped", percent: 81, resets_at: null, scope: { model: null } },
    ];
    expect(fableUsageWindowFromLimits(noModel)).toBeNull();
  });

  it("prefers the entry whose model name matches fable, regardless of order", () => {
    const two: UsageLimit[] = [
      { kind: "weekly_scoped", percent: 20, resets_at: null, scope: { model: { id: null, display_name: "Opus" } } },
      { kind: "weekly_scoped", percent: 77, resets_at: null, scope: { model: { id: null, display_name: "Fable" } } },
    ];
    expect(fableUsageWindowFromLimits(two)?.utilization).toBe(77);
  });

  it("falls back to the first model-scoped entry when no name matches fable", () => {
    const renamed: UsageLimit[] = [
      { kind: "weekly_scoped", percent: 33, resets_at: null, scope: { model: { id: null, display_name: "Mythos" } } },
      { kind: "weekly_scoped", percent: 44, resets_at: null, scope: { model: { id: null, display_name: "Opus" } } },
    ];
    expect(fableUsageWindowFromLimits(renamed)?.utilization).toBe(33);
  });

  it("returns null when percent is null (the cast is unvalidated — degrade, don't throw)", () => {
    const nullPercent: UsageLimit[] = [
      { kind: "weekly_scoped", percent: null, resets_at: "2026-07-24T07:00:00.337368+00:00", scope: { model: { id: null, display_name: "Fable" } } },
    ];
    expect(fableUsageWindowFromLimits(nullPercent)).toBeNull();
  });

  it("keeps resets_at null when the entry has a percent but no reset", () => {
    const noReset: UsageLimit[] = [
      { kind: "weekly_scoped", percent: 77, resets_at: null, scope: { model: { id: null, display_name: "Fable" } } },
    ];
    expect(fableUsageWindowFromLimits(noReset)).toEqual({ utilization: 77, resets_at: null });
  });
});

describe("buildSnapshot", () => {
  const now = new Date("2026-05-11T00:00:00.000Z");

  it("maps the full payload including per-model windows and extra_usage", () => {
    const snap = buildSnapshot(
      "personal",
      {
        five_hour: { utilization: 50, resets_at: null },
        seven_day: { utilization: 12, resets_at: null },
        seven_day_opus: { utilization: 20, resets_at: null },
        seven_day_sonnet: { utilization: 5, resets_at: null },
        extra_usage: {
          is_enabled: true,
          monthly_limit: 100,
          used_credits: 35,
          utilization: 35,
          currency: "USD",
        },
      },
      now,
    );
    expect(snap.slug).toBe("personal");
    expect(snap.fiveHour?.utilization).toBeCloseTo(0.5, 6);
    expect(snap.sevenDay?.utilization).toBeCloseTo(0.12, 6);
    expect(snap.perModel.opus?.utilization).toBeCloseTo(0.2, 6);
    expect(snap.perModel.sonnet?.utilization).toBeCloseTo(0.05, 6);
    expect(snap.extraUsage).toEqual({
      enabled: true,
      usedCredits: 35,
      monthlyLimit: 100,
      utilization: 35,
      currency: "USD",
    });
    expect(snap.fetchedAt).toBe(now);
    expect(snap.cooldownUntil).toBeNull();
  });

  it("omits per-model entries that aren't present", () => {
    const snap = buildSnapshot(
      null,
      {
        five_hour: { utilization: 10, resets_at: null },
        seven_day: { utilization: 5, resets_at: null },
      },
      now,
    );
    expect(snap.slug).toBeNull();
    expect(snap.perModel.opus).toBeUndefined();
    expect(snap.perModel.sonnet).toBeUndefined();
    expect(snap.perModel.fable).toBeUndefined();
    expect(snap.extraUsage).toBeUndefined();
  });

  it("maps the Fable weekly window from the limits array (current API shape)", () => {
    const snap = buildSnapshot(
      null,
      {
        five_hour: { utilization: 52, resets_at: "2026-07-21T19:30:00.337054+00:00" },
        seven_day: { utilization: 63, resets_at: "2026-07-24T07:00:00.337077+00:00" },
        seven_day_opus: null,
        seven_day_sonnet: null,
        limits: LIVE_LIMITS,
      },
      now,
    );
    expect(snap.perModel.fable?.utilization).toBeCloseTo(0.77, 6);
    expect(snap.perModel.fable?.resetsAt).toBeInstanceOf(Date);
    expect(snap.perModel.opus).toBeUndefined();
    expect(snap.perModel.sonnet).toBeUndefined();
  });
});

describe("computeBackoffMs", () => {
  it("uses the minimum when retry-after is missing or zero", () => {
    expect(computeBackoffMs(null)).toBe(MIN_BACKOFF_MS);
    expect(computeBackoffMs(undefined)).toBe(MIN_BACKOFF_MS);
    expect(computeBackoffMs(0)).toBe(MIN_BACKOFF_MS);
  });

  it("rejects NaN / Infinity / negative hints, falling back to the floor", () => {
    expect(computeBackoffMs(NaN)).toBe(MIN_BACKOFF_MS);
    expect(computeBackoffMs(Infinity)).toBe(MIN_BACKOFF_MS);
    expect(computeBackoffMs(-1000)).toBe(MIN_BACKOFF_MS);
  });

  it("clamps small hints UP to the floor", () => {
    expect(computeBackoffMs(1_000)).toBe(MIN_BACKOFF_MS);
  });

  it("passes through a hint within the [floor, ceiling] band", () => {
    expect(computeBackoffMs(120_000)).toBe(120_000);
  });

  it("clamps oversized hints DOWN to the ceiling", () => {
    expect(computeBackoffMs(60 * 60_000)).toBe(MAX_BACKOFF_MS);
  });
});

describe("clampAutoInterval", () => {
  it("returns 0 for non-positive input", () => {
    expect(clampAutoInterval(0)).toBe(0);
    expect(clampAutoInterval(-1)).toBe(0);
  });

  it("raises sub-minimum to the 5-minute floor", () => {
    expect(clampAutoInterval(60_000)).toBe(MIN_AUTO_POLL_MS);
    expect(clampAutoInterval(MIN_AUTO_POLL_MS - 1)).toBe(MIN_AUTO_POLL_MS);
  });

  it("passes through values at or above the floor", () => {
    expect(clampAutoInterval(MIN_AUTO_POLL_MS)).toBe(MIN_AUTO_POLL_MS);
    expect(clampAutoInterval(15 * 60_000)).toBe(15 * 60_000);
  });
});

describe("decideRefresh", () => {
  const baseline = { now: 1_000_000, lastAttemptAt: 0, backoffUntil: 0, inFlight: false };

  it("returns in-flight when a request is already running", () => {
    expect(decideRefresh({ ...baseline, inFlight: true })).toBe("in-flight");
  });

  it("returns backoff when now < backoffUntil", () => {
    expect(decideRefresh({ ...baseline, backoffUntil: baseline.now + 1_000 })).toBe("backoff");
  });

  it("returns coalesce when within the 5s floor since lastAttemptAt", () => {
    expect(
      decideRefresh({ ...baseline, lastAttemptAt: baseline.now - (MIN_REFRESH_GAP_MS - 1) }),
    ).toBe("coalesce");
  });

  it("returns fetch when the coalesce window has elapsed", () => {
    expect(
      decideRefresh({ ...baseline, lastAttemptAt: baseline.now - MIN_REFRESH_GAP_MS }),
    ).toBe("fetch");
  });

  it("prioritises in-flight over backoff", () => {
    expect(
      decideRefresh({ ...baseline, inFlight: true, backoffUntil: baseline.now + 999 }),
    ).toBe("in-flight");
  });

  it("prioritises backoff over coalesce", () => {
    expect(
      decideRefresh({
        ...baseline,
        backoffUntil: baseline.now + 999,
        lastAttemptAt: baseline.now - 1,
      }),
    ).toBe("backoff");
  });
});

describe("backoffLabel", () => {
  it("renders the 429 label by default and for 'rate'", () => {
    expect(backoffLabel(undefined, 30_000)).toBe("429 (wait 30s)");
    expect(backoffLabel("rate", 30_000)).toBe("429 (wait 30s)");
  });

  it("renders the auth-expired label when the backoff was set by a 401/403", () => {
    expect(backoffLabel("auth", 1_760_000)).toBe("auth expired (wait 1760s)");
  });

  it("rounds milliseconds to whole seconds", () => {
    expect(backoffLabel("rate", 1_499)).toBe("429 (wait 1s)");
    expect(backoffLabel("rate", 1_500)).toBe("429 (wait 2s)");
  });

  it("clamps non-positive waits to a 1s minimum so users see a live countdown", () => {
    expect(backoffLabel("rate", 0)).toBe("429 (wait 1s)");
    expect(backoffLabel("auth", -1_000)).toBe("auth expired (wait 1s)");
  });
});
