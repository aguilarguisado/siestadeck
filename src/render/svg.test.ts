import { describe, expect, it } from "vitest";

import { formatResetTime, renderAttention, renderQuotaMeter, renderValueKey } from "./svg.js";

describe("renderQuotaMeter", () => {
  it("renders a 5h meter at known utilization", () => {
    const svg = renderQuotaMeter({ utilization: 0.42, window: "5h", label: "5H" });
    expect(svg).toMatchSnapshot();
  });

  it("renders a 7d meter at high utilization (red band)", () => {
    const svg = renderQuotaMeter({ utilization: 0.9, window: "7d", label: "7D" });
    expect(svg).toMatchSnapshot();
  });

  it("renders the unknown state (null utilization)", () => {
    const svg = renderQuotaMeter({ utilization: null, window: "5h", label: "5H" });
    expect(svg).toMatchSnapshot();
  });

  it("renders a WAIT cooldown badge when cooldownSeconds > 0", () => {
    const svg = renderQuotaMeter({ utilization: 0.5, window: "5h", label: "5H", cooldownSeconds: 42 });
    expect(svg).toContain("WAIT 42s");
  });

  it("does NOT render WAIT badge when cooldownSeconds is 0 or missing", () => {
    const a = renderQuotaMeter({ utilization: 0.5, window: "5h", label: "5H", cooldownSeconds: 0 });
    const b = renderQuotaMeter({ utilization: 0.5, window: "5h", label: "5H" });
    expect(a).not.toContain("WAIT");
    expect(b).not.toContain("WAIT");
  });

  it("renders the top countdown pill in H:MM when resetsInSeconds > 0", () => {
    const svg = renderQuotaMeter({
      utilization: 0.5,
      window: "5h",
      label: "5H",
      resetsInSeconds: 2 * 3600 + 14 * 60,
    });
    expect(svg).toContain(">2:14<");
    // Top pill: filled accent at y=6 (matches the bottom 5h/7d label-pill styling).
    expect(svg).toContain('y="6"');
  });

  it("renders the top countdown pill in days when resetsInSeconds >= 1 day", () => {
    const svg = renderQuotaMeter({
      utilization: 0.5,
      window: "7d",
      label: "7D",
      resetsInSeconds: 3 * 24 * 3600 + 5 * 3600,
    });
    expect(svg).toContain(">3d<");
  });

  it("omits the top countdown pill when resetsInSeconds is null/0/sub-minute", () => {
    const a = renderQuotaMeter({ utilization: 0.5, window: "5h", label: "5H" });
    const b = renderQuotaMeter({ utilization: 0.5, window: "5h", label: "5H", resetsInSeconds: 0 });
    const c = renderQuotaMeter({ utilization: 0.5, window: "5h", label: "5H", resetsInSeconds: null });
    const d = renderQuotaMeter({ utilization: 0.5, window: "5h", label: "5H", resetsInSeconds: 30 });
    // The only rect at y="6" is the top pill; absence == no pill.
    for (const svg of [a, b, c, d]) expect(svg).not.toContain('y="6"');
  });

  it("hides the top countdown pill while WAIT cooldown is active", () => {
    const svg = renderQuotaMeter({
      utilization: 0.5,
      window: "5h",
      label: "5H",
      cooldownSeconds: 42,
      resetsInSeconds: 3600,
    });
    expect(svg).toContain("WAIT 42s");
    // Top pill suppressed while cooldown owns the top slot.
    expect(svg).not.toContain('y="6"');
  });
});

describe("formatResetTime", () => {
  it("returns empty string for null / non-positive / sub-minute", () => {
    expect(formatResetTime(null)).toBe("");
    expect(formatResetTime(undefined)).toBe("");
    expect(formatResetTime(0)).toBe("");
    expect(formatResetTime(45)).toBe("");
    expect(formatResetTime(59)).toBe("");
  });

  it("returns H:MM for sub-day durations with zero-padded minutes", () => {
    expect(formatResetTime(60)).toBe("0:01");
    expect(formatResetTime(30 * 60)).toBe("0:30");
    expect(formatResetTime(3600)).toBe("1:00");
    expect(formatResetTime(2 * 3600 + 14 * 60)).toBe("2:14");
    expect(formatResetTime(23 * 3600 + 59 * 60)).toBe("23:59");
  });

  it("returns Nd for multi-day durations (floor)", () => {
    expect(formatResetTime(24 * 3600)).toBe("1d");
    expect(formatResetTime(2 * 24 * 3600 - 1)).toBe("1d"); // floors: anything ≥24h reads as Nd
    expect(formatResetTime(3 * 24 * 3600)).toBe("3d");
    expect(formatResetTime(3 * 24 * 3600 + 5 * 3600)).toBe("3d");
  });

  it("crosses the day boundary cleanly", () => {
    expect(formatResetTime(24 * 3600 - 60)).toBe("23:59");
    expect(formatResetTime(24 * 3600)).toBe("1d");
  });
});

describe("renderAttention", () => {
  it("renders every mode (snapshots)", () => {
    expect(renderAttention({ mode: "setup" })).toMatchSnapshot("setup");
    expect(renderAttention({ mode: "quiet" })).toMatchSnapshot("quiet");
    expect(renderAttention({ mode: "blocked", flashOn: true, label: "siesta" })).toMatchSnapshot("blocked-on");
    expect(renderAttention({ mode: "blocked", flashOn: false, label: "siesta" })).toMatchSnapshot("blocked-off");
    expect(renderAttention({ mode: "turn_done", label: "siesta" })).toMatchSnapshot("turn-done");
    expect(renderAttention({ mode: "idle" })).toMatchSnapshot("idle");
  });

  it("blocked flash frames swap the danger color between fill and glyph", () => {
    const on = renderAttention({ mode: "blocked", flashOn: true });
    const off = renderAttention({ mode: "blocked", flashOn: false });
    expect(on).toContain('fill="#E5534B"'); // solid danger background
    expect(off).toContain('stroke="#E5534B"'); // danger ring on dark background
    expect(on).not.toBe(off);
  });

  it("shows a count badge above one session, capped at 9+", () => {
    expect(renderAttention({ mode: "blocked", sessionCount: 1 })).not.toContain('cy="26"');
    expect(renderAttention({ mode: "blocked", sessionCount: 3 })).toContain(">3<");
    expect(renderAttention({ mode: "idle", sessionCount: 12 })).toContain(">9+<");
  });

  it("HTML-escapes the label", () => {
    const svg = renderAttention({ mode: "turn_done", label: "a&b<c>" });
    expect(svg).toContain("a&amp;b&lt;c&gt;");
    expect(svg).not.toContain("<c>");
  });

  it("setup mode carries the install hint", () => {
    expect(renderAttention({ mode: "setup" })).toContain("press to install");
  });
});

describe("renderValueKey", () => {
  it("renders a basic value + label", () => {
    expect(renderValueKey({ value: "$1.23", label: "Today" })).toMatchSnapshot();
  });

  it("uppercases the label", () => {
    const svg = renderValueKey({ value: "5", label: "sessions" });
    expect(svg).toContain("SESSIONS");
  });

  it("renders a unit when present", () => {
    const svg = renderValueKey({ value: "42", unit: "tok", label: "Burn" });
    expect(svg).toContain("tok");
  });

  it("HTML-escapes user-supplied label and value", () => {
    // Short value so the length guard does not truncate it out from under the
    // escaping assertions — escaping and truncation are independent concerns.
    const svg = renderValueKey({ value: `<i>&"'`, label: "a&b<c>" });
    expect(svg).toContain("&lt;i&gt;");
    expect(svg).toContain("&amp;");
    expect(svg).toContain("&quot;");
    expect(svg).not.toContain("<i>");
  });

  it("leaves short values at full size and unchanged", () => {
    const svg = renderValueKey({ value: "Fable", label: "model" });
    expect(svg).toContain('font-size="38"');
    expect(svg).toContain(">Fable<");
  });

  it("shrinks and ellipsis-truncates an over-long value instead of clipping", () => {
    const svg = renderValueKey({ value: "claude-unknown-99", label: "model" });
    expect(svg).toContain('font-size="28"');
    expect(svg).toContain("…");
    expect(svg).not.toContain("claude-unknown-99");
  });

  it("does not shrink or truncate a value that carries a unit", () => {
    const svg = renderValueKey({ value: "1234567890123", unit: "tok", label: "burn" });
    expect(svg).toContain('font-size="38"');
    expect(svg).not.toContain("…");
  });
});
