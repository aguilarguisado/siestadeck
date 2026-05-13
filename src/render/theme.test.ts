import { describe, expect, it } from "vitest";

import { colors, quotaColor, SIZE } from "./theme.js";

describe("quotaColor", () => {
  it("returns green below 60% utilization", () => {
    expect(quotaColor(0)).toBe(colors.ok);
    expect(quotaColor(0.3)).toBe(colors.ok);
    expect(quotaColor(0.5999)).toBe(colors.ok);
  });

  it("returns amber from 60% up to (but not including) 85%", () => {
    expect(quotaColor(0.6)).toBe(colors.warn);
    expect(quotaColor(0.7)).toBe(colors.warn);
    expect(quotaColor(0.8499)).toBe(colors.warn);
  });

  it("returns red from 85% up to (but not including) 100%", () => {
    expect(quotaColor(0.85)).toBe(colors.danger);
    expect(quotaColor(0.95)).toBe(colors.danger);
    expect(quotaColor(0.9999)).toBe(colors.danger);
  });

  it("returns siesta accent at and above 100% (easter egg state)", () => {
    expect(quotaColor(1.0)).toBe(colors.siestaAccent);
    expect(quotaColor(1.5)).toBe(colors.siestaAccent);
  });
});

describe("colors and SIZE constants", () => {
  it("exposes a 144px canvas size", () => {
    expect(SIZE).toBe(144);
  });

  it("exposes the expected theme keys", () => {
    expect(colors.bg).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(colors.ok).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(colors.warn).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(colors.danger).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });
});
