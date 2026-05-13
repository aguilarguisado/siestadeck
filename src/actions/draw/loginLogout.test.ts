import { describe, expect, it } from "vitest";

import { drawLoginLogout } from "./loginLogout.js";

describe("drawLoginLogout", () => {
  it("renders 'log in' by default", () => {
    const { svg } = drawLoginLogout({});
    expect(svg).toContain(">log in<");
    expect(svg).toContain(">CLAUDE AUTH<");
  });

  it("renders 'log out' for mode=logout", () => {
    const { svg } = drawLoginLogout({ mode: "logout" });
    expect(svg).toContain(">log out<");
  });

  it("renders 'log in' for mode=login (explicit)", () => {
    const { svg } = drawLoginLogout({ mode: "login" });
    expect(svg).toContain(">log in<");
  });
});
