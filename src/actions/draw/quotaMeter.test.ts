import { describe, expect, it } from "vitest";

import { drawQuotaMeter } from "./quotaMeter.js";
import type { QuotaSnapshot } from "../../services/quota.js";

function snapshot(overrides: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return {
    slug: null,
    fiveHour: { utilization: 0.42, resetsAt: null },
    sevenDay: { utilization: 0.18, resetsAt: null },
    perModel: {},
    fetchedAt: new Date(),
    cooldownUntil: null,
    ...overrides,
  };
}

describe("drawQuotaMeter", () => {
  it("defaults to the 5h window", () => {
    const { svg } = drawQuotaMeter({ snap: snapshot() });
    expect(svg).toContain(">5H<");
  });

  it("renders the 7d window when requested", () => {
    const { svg } = drawQuotaMeter({ snap: snapshot(), window: "7d" });
    expect(svg).toContain(">7D<");
    expect(svg).toContain(">18<"); // 0.18 → 18%
  });

  it("falls back to '--' when snapshot is null", () => {
    const { svg } = drawQuotaMeter({ snap: null });
    expect(svg).toContain(">--<");
  });

  it("computes positive cooldown seconds when cooldownUntil is in the future", () => {
    const now = 1_000_000_000_000;
    const snap = snapshot({ cooldownUntil: new Date(now + 5_500) });
    const { svg, cooldownSeconds } = drawQuotaMeter({ snap, now });
    expect(cooldownSeconds).toBe(6); // ceil(5.5)
    expect(svg).toContain("WAIT 6s");
  });

  it("clamps cooldown to zero when cooldownUntil is in the past", () => {
    const now = 1_000_000_000_000;
    const snap = snapshot({ cooldownUntil: new Date(now - 1_000) });
    const { svg, cooldownSeconds } = drawQuotaMeter({ snap, now });
    expect(cooldownSeconds).toBe(0);
    expect(svg).not.toContain("WAIT");
  });

  it("zero cooldown when cooldownUntil is null", () => {
    const { cooldownSeconds } = drawQuotaMeter({ snap: snapshot(), now: 0 });
    expect(cooldownSeconds).toBe(0);
  });

  it("renders the LOG IN tile (not WAIT) when cooldownReason is auth", () => {
    const now = 1_000_000_000_000;
    const snap = snapshot({ cooldownUntil: new Date(now + 30 * 60_000), cooldownReason: "auth" });
    const { svg, cooldownSeconds, isSiesta } = drawQuotaMeter({ snap, now });
    expect(svg).toContain("LOG IN");
    expect(svg).not.toContain("WAIT");
    // Static tile: the countdown tick is suppressed so the action doesn't
    // needlessly re-render every second for the 30-min auth backoff.
    expect(cooldownSeconds).toBe(0);
    expect(isSiesta).toBe(false);
  });

  it("still renders the WAIT badge for a rate-limit cooldown (cooldownReason rate)", () => {
    const now = 1_000_000_000_000;
    const snap = snapshot({ cooldownUntil: new Date(now + 42_000), cooldownReason: "rate" });
    const { svg, cooldownSeconds } = drawQuotaMeter({ snap, now });
    expect(svg).toContain("WAIT 42s");
    expect(svg).not.toContain("LOG IN");
    expect(cooldownSeconds).toBe(42);
  });

  it("computes resetsInSeconds from the active window's resetsAt", () => {
    const now = 1_000_000_000_000;
    const snap = snapshot({
      fiveHour: { utilization: 0.5, resetsAt: new Date(now + 2 * 3600_000 + 14 * 60_000) },
    });
    const { svg, resetsInSeconds } = drawQuotaMeter({ snap, window: "5h", now });
    expect(resetsInSeconds).toBe(2 * 3600 + 14 * 60);
    expect(svg).toContain(">2:14<");
  });

  it("uses the 7d window's resetsAt when window=7d", () => {
    const now = 1_000_000_000_000;
    const snap = snapshot({
      fiveHour: { utilization: 0.5, resetsAt: new Date(now + 60_000) },
      sevenDay: { utilization: 0.2, resetsAt: new Date(now + 3 * 24 * 3600_000) },
    });
    const { svg, resetsInSeconds } = drawQuotaMeter({ snap, window: "7d", now });
    expect(resetsInSeconds).toBe(3 * 24 * 3600);
    expect(svg).toContain(">3d<");
  });

  it("renders the fable window from perModel.fable", () => {
    const snap = snapshot({ perModel: { fable: { utilization: 0.77, resetsAt: null } } });
    const { svg } = drawQuotaMeter({ snap, window: "fable" });
    expect(svg).toContain(">FABLE<");
    expect(svg).toContain(">77<"); // 0.77 → 77%
  });

  it("renders '--' with the FABLE pill when the snapshot has no fable window", () => {
    const { svg } = drawQuotaMeter({ snap: snapshot(), window: "fable" });
    expect(svg).toContain(">FABLE<");
    expect(svg).toContain(">--<");
  });

  it("falls back to '--' for window=fable when snapshot is null", () => {
    const { svg } = drawQuotaMeter({ snap: null, window: "fable" });
    expect(svg).toContain(">--<");
  });

  it("uses the fable window's resetsAt, not the 5h/7d ones", () => {
    const now = 1_000_000_000_000;
    const snap = snapshot({
      fiveHour: { utilization: 0.5, resetsAt: new Date(now + 60_000) },
      sevenDay: { utilization: 0.2, resetsAt: new Date(now + 24 * 3600_000) },
      perModel: { fable: { utilization: 0.77, resetsAt: new Date(now + 3 * 24 * 3600_000) } },
    });
    const { svg, resetsInSeconds } = drawQuotaMeter({ snap, window: "fable", now });
    expect(resetsInSeconds).toBe(3 * 24 * 3600);
    expect(svg).toContain(">3d<");
  });

  it("enters siesta when the fable window hits 100%", () => {
    const at = (utilization: number) =>
      drawQuotaMeter({
        snap: snapshot({ perModel: { fable: { utilization, resetsAt: null } } }),
        window: "fable",
      }).isSiesta;
    expect(at(1.0)).toBe(true);
    expect(at(0.99)).toBe(false);
  });

  it("renders the LOG IN tile with the FABLE pill on auth cooldown", () => {
    const now = 1_000_000_000_000;
    const snap = snapshot({ cooldownUntil: new Date(now + 30 * 60_000), cooldownReason: "auth" });
    const { svg, cooldownSeconds } = drawQuotaMeter({ snap, window: "fable", now });
    expect(svg).toContain("LOG IN");
    expect(svg).toContain(">FABLE<");
    expect(cooldownSeconds).toBe(0);
  });

  it("hides the top countdown pill when resetsAt is in the past or absent", () => {
    const now = 1_000_000_000_000;
    const past = snapshot({ fiveHour: { utilization: 0.5, resetsAt: new Date(now - 1_000) } });
    const result = drawQuotaMeter({ snap: past, now });
    expect(result.resetsInSeconds).toBe(0);
    // The only rect at y="6" is the top pill; absence == no pill.
    expect(result.svg).not.toContain('y="6"');
  });

  it("isSiesta is true when utilization is at or above 1 (the action then setImage()s the pre-baked GIF instead of the svg)", () => {
    const snap = snapshot({ fiveHour: { utilization: 1.0, resetsAt: null } });
    expect(drawQuotaMeter({ snap }).isSiesta).toBe(true);
    expect(drawQuotaMeter({ snap: snapshot({ fiveHour: { utilization: 1.5, resetsAt: null } }) }).isSiesta).toBe(true);
  });

  it("isSiesta is false when utilization is below 1", () => {
    const { isSiesta } = drawQuotaMeter({ snap: snapshot({ fiveHour: { utilization: 0.99, resetsAt: null } }) });
    expect(isSiesta).toBe(false);
  });
});
