import { describe, expect, it } from "vitest";

import { UNKNOWN, formatPercent, formatResetsIn, formatWait } from "./format.js";

const NOW = new Date("2026-09-17T12:00:00Z");
const inSeconds = (s: number) => new Date(NOW.getTime() + s * 1000);

describe("formatPercent", () => {
  it("renders a 0..1 utilization as a whole percentage", () => {
    expect(formatPercent(0.183)).toBe("18%");
    expect(formatPercent(0.76)).toBe("76%");
    expect(formatPercent(0)).toBe("0%");
  });

  it("does not clamp a spent window below 100%", () => {
    expect(formatPercent(1)).toBe("100%");
    expect(formatPercent(1.2)).toBe("120%");
  });

  it("falls back to the placeholder for absent or nonsense values", () => {
    expect(formatPercent(null)).toBe(UNKNOWN);
    expect(formatPercent(undefined)).toBe(UNKNOWN);
    expect(formatPercent(Number.NaN)).toBe(UNKNOWN);
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe(UNKNOWN);
  });
});

describe("formatResetsIn", () => {
  it("returns empty for a reset that is absent or already past", () => {
    expect(formatResetsIn(null, NOW)).toBe("");
    expect(formatResetsIn(undefined, NOW)).toBe("");
    expect(formatResetsIn(inSeconds(-1), NOW)).toBe("");
    expect(formatResetsIn(NOW, NOW)).toBe("");
  });

  it("says 'under a minute' rather than counting seconds", () => {
    expect(formatResetsIn(inSeconds(1), NOW)).toBe("under a minute");
    expect(formatResetsIn(inSeconds(59), NOW)).toBe("under a minute");
  });

  it("renders minutes under the hour", () => {
    expect(formatResetsIn(inSeconds(60), NOW)).toBe("1m");
    expect(formatResetsIn(inSeconds(42 * 60), NOW)).toBe("42m");
    expect(formatResetsIn(inSeconds(59 * 60 + 59), NOW)).toBe("59m");
  });

  it("renders hours and minutes under the day", () => {
    expect(formatResetsIn(inSeconds(75 * 60), NOW)).toBe("1h 15m");
    expect(formatResetsIn(inSeconds(23 * 3600 + 59 * 60), NOW)).toBe("23h 59m");
  });

  it("drops a zero minutes component", () => {
    expect(formatResetsIn(inSeconds(3 * 3600), NOW)).toBe("3h");
  });

  it("renders days and hours past the day, unlike the tile's whole-day collapse", () => {
    expect(formatResetsIn(inSeconds(2 * 86400 + 3 * 3600), NOW)).toBe("2d 3h");
    expect(formatResetsIn(inSeconds(7 * 86400), NOW)).toBe("7d");
  });

  it("drops a zero hours component", () => {
    expect(formatResetsIn(inSeconds(86400), NOW)).toBe("1d");
  });
});

describe("formatWait", () => {
  it("returns empty once the cooldown has expired", () => {
    expect(formatWait(null, NOW)).toBe("");
    expect(formatWait(undefined, NOW)).toBe("");
    expect(formatWait(inSeconds(-5), NOW)).toBe("");
  });

  it("counts seconds under the minute, where 'under a minute' would be useless", () => {
    expect(formatWait(inSeconds(47), NOW)).toBe("47s");
    expect(formatWait(inSeconds(1), NOW)).toBe("1s");
  });

  it("renders minutes and seconds past the minute", () => {
    expect(formatWait(inSeconds(200), NOW)).toBe("3m 20s");
  });

  it("drops a zero seconds component", () => {
    expect(formatWait(inSeconds(600), NOW)).toBe("10m");
  });
});
