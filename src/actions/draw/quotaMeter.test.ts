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
