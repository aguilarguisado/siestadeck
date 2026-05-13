import { describe, expect, it } from "vitest";

import { drawActiveModel, shortName } from "./activeModel.js";

describe("shortName", () => {
  it("identifies the three known model families regardless of versioning suffix", () => {
    expect(shortName("claude-opus-4-20260101").name).toBe("Opus");
    expect(shortName("claude-haiku-3-5-haiku-20240801").name).toBe("Haiku");
    expect(shortName("Sonnet-4").name).toBe("Sonnet");
  });

  it("uses themed accent colors per family", () => {
    expect(shortName("opus").accent).toBe("#D0776C");
    expect(shortName("haiku").accent).toBe("#E5A38A");
    expect(shortName("sonnet").accent).toBe("#F2C744");
  });

  it("returns -- with dim accent on null", () => {
    const r = shortName(null);
    expect(r.name).toBe("--");
    expect(r.accent).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it("passes unknown model strings through with the default text color", () => {
    const r = shortName("claude-mystery-9");
    expect(r.name).toBe("claude-mystery-9");
  });
});

describe("drawActiveModel", () => {
  it("renders the active model when no pin is set", () => {
    const { svg } = drawActiveModel({ activeModel: "claude-sonnet-4" });
    expect(svg).toContain(">Sonnet<");
  });

  it("pin overrides activeModel", () => {
    const { svg } = drawActiveModel({ activeModel: "claude-sonnet-4", pinned: "opus" });
    expect(svg).toContain(">Opus<");
  });

  it("renders -- when both pin and activeModel are absent", () => {
    const { svg } = drawActiveModel({ activeModel: null });
    expect(svg).toContain(">--<");
  });
});
