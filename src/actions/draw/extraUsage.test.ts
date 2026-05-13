import { describe, expect, it } from "vitest";

import { drawExtraUsage, extraUsageDisplay, fmtUsd } from "./extraUsage.js";
import type { QuotaSnapshot } from "../../services/quota.js";

function snap(extraUsage?: QuotaSnapshot["extraUsage"]): QuotaSnapshot {
  return {
    slug: null,
    fiveHour: null,
    sevenDay: null,
    perModel: {},
    extraUsage,
    fetchedAt: new Date(),
    cooldownUntil: null,
  };
}

describe("fmtUsd", () => {
  it("uses 2-decimal precision below $1", () => {
    expect(fmtUsd(0.1)).toBe("$0.10");
  });

  it("uses 1-decimal precision between $1 and $100", () => {
    expect(fmtUsd(4.2)).toBe("$4.2");
  });

  it("rounds to whole dollars at or above $100", () => {
    expect(fmtUsd(123.4)).toBe("$123");
  });
});

describe("extraUsageDisplay", () => {
  it("returns -- when there is no snapshot or no extra_usage block", () => {
    expect(extraUsageDisplay(null)).toEqual({ value: "--", label: "extra usage", small: false });
    expect(extraUsageDisplay(snap(undefined))).toEqual({
      value: "--",
      label: "extra usage",
      small: false,
    });
  });

  it("returns 'off' when extra usage is not enabled on the account", () => {
    const d = extraUsageDisplay(
      snap({ enabled: false, usedCredits: null, monthlyLimit: null, utilization: null, currency: null }),
    );
    expect(d.value).toBe("off");
  });

  it("returns -- when enabled but no credits figure is reported yet", () => {
    const d = extraUsageDisplay(
      snap({ enabled: true, usedCredits: null, monthlyLimit: 50, utilization: null, currency: "USD" }),
    );
    expect(d.value).toBe("--");
  });

  it("shows the spent amount with the monthly cap in the label", () => {
    const d = extraUsageDisplay(
      snap({ enabled: true, usedCredits: 4.2, monthlyLimit: 50, utilization: 8, currency: "USD" }),
    );
    expect(d).toEqual({ value: "$4.2", label: "extra · $50", small: false });
  });

  it("falls back to a plain label when no monthly cap is set", () => {
    const d = extraUsageDisplay(
      snap({ enabled: true, usedCredits: 4.2, monthlyLimit: null, utilization: null, currency: "USD" }),
    );
    expect(d.label).toBe("extra usage");
  });

  it("uses the small layout once spend reaches $100", () => {
    const d = extraUsageDisplay(
      snap({ enabled: true, usedCredits: 150, monthlyLimit: 200, utilization: 75, currency: "USD" }),
    );
    expect(d.small).toBe(true);
  });
});

describe("drawExtraUsage", () => {
  it("renders the spent amount and uppercased label into the SVG", () => {
    const { svg } = drawExtraUsage({
      snap: snap({ enabled: true, usedCredits: 4.2, monthlyLimit: 50, utilization: 8, currency: "USD" }),
    });
    expect(svg).toContain("$4.2");
    expect(svg).toContain("EXTRA · $50");
  });

  it("renders -- when the snapshot is null", () => {
    const { svg } = drawExtraUsage({ snap: null });
    expect(svg).toContain(">--<");
  });
});
