import { describe, expect, it } from "vitest";

import { drawSwitchAccount } from "./switchAccount.js";

const PERSONAL = { slug: "personal", displayName: "personal", color: "#7AA2F7" };
const WORK = { slug: "work", displayName: "workmail", color: "#F2C744" };

describe("drawSwitchAccount", () => {
  it("renders the active account in default 'next' mode (up to 7 chars)", () => {
    const { svg } = drawSwitchAccount({ active: PERSONAL });
    expect(svg).toContain(">personal<".slice(0, 8) + "<"); // first 7 chars
    expect(svg).toContain(">SWAP ACCT<");
  });

  it("renders the target with an arrow in 'specific' mode (up to 6 chars + arrow)", () => {
    const { svg } = drawSwitchAccount({ active: PERSONAL, target: WORK, mode: "specific" });
    expect(svg).toContain("→workma");
    expect(svg).toContain(">SWITCH TO<");
  });

  it("ignores target when mode is not 'specific'", () => {
    const { svg } = drawSwitchAccount({ active: PERSONAL, target: WORK, mode: "next" });
    expect(svg).not.toContain("→");
  });

  it("falls back to -- when no active and no target", () => {
    const { svg } = drawSwitchAccount({ active: null });
    expect(svg).toContain(">--<");
  });

  it("uses the target's accent color when present, else the active color", () => {
    const a = drawSwitchAccount({ active: PERSONAL });
    expect(a.svg).toContain(PERSONAL.color);
    const b = drawSwitchAccount({ active: PERSONAL, target: WORK, mode: "specific" });
    expect(b.svg).toContain(WORK.color);
  });

  it("switches to the small font when the rendered value is longer than 5 chars", () => {
    const { svg } = drawSwitchAccount({ active: PERSONAL });
    // "personal".slice(0, 7) = "persona" — length 7 > 5
    expect(svg).toContain('font-size="28"');
  });
});
