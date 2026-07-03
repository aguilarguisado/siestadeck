import { describe, expect, it } from "vitest";

import type { AttentionSessionView, AttentionSnapshot } from "../../services/attentionPolicy.js";
import { cwdLabel, drawAttention } from "./attention.js";

const NOW = 1_700_000_000_000;

function session(overrides: Partial<AttentionSessionView>): AttentionSessionView {
  return {
    sessionId: "s1",
    state: "blocked",
    since: NOW,
    cwd: "/Users/juan/Projects/lab/siesta",
    acked: false,
    ...overrides,
  };
}

function snap(sessions: AttentionSessionView[], hooksInstalled = true): AttentionSnapshot {
  const worst = sessions.find((s) => !s.acked)?.state ?? null;
  return { hooksInstalled, sessions, worst, fetchedAt: new Date(NOW) };
}

describe("cwdLabel", () => {
  it("takes the basename and handles trailing separators", () => {
    expect(cwdLabel("/Users/juan/Projects/lab/siesta")).toBe("siesta");
    expect(cwdLabel("/Users/juan/Projects/lab/siesta/")).toBe("siesta");
  });

  it("handles Windows paths", () => {
    expect(cwdLabel("C:\\Users\\juan\\dev\\siesta")).toBe("siesta");
  });

  it("truncates long names with an ellipsis", () => {
    expect(cwdLabel("/x/a-very-long-project-name")).toBe("a-very-long…");
  });

  it("returns undefined for null or empty", () => {
    expect(cwdLabel(null)).toBeUndefined();
    expect(cwdLabel("///")).toBeUndefined();
  });
});

describe("drawAttention", () => {
  it("renders SETUP when there is no snapshot yet or hooks are missing", () => {
    for (const input of [null, snap([], false)]) {
      const { svg, flashing } = drawAttention({ snap: input, settings: {}, flashFrame: 0 });
      expect(svg).toContain("SETUP");
      expect(flashing).toBe(false);
    }
  });

  it("renders QUIET when nothing is alarming", () => {
    const { svg, flashing } = drawAttention({ snap: snap([]), settings: {}, flashFrame: 0 });
    expect(svg).toContain("QUIET");
    expect(flashing).toBe(false);
  });

  it("renders a flashing WAITING tile for a blocked session", () => {
    const on = drawAttention({ snap: snap([session({})]), settings: {}, flashFrame: 0 });
    const off = drawAttention({ snap: snap([session({})]), settings: {}, flashFrame: 1 });
    expect(on.flashing).toBe(true);
    expect(off.flashing).toBe(true);
    expect(on.svg).toContain("WAITING");
    expect(off.svg).toContain("WAITING");
    expect(on.svg).not.toBe(off.svg); // two distinct frames
    expect(on.svg).toContain("siesta"); // cwd label present
  });

  it("renders static DONE and IDLE tiles (no flashing)", () => {
    const done = drawAttention({ snap: snap([session({ state: "turn_done" })]), settings: {}, flashFrame: 0 });
    expect(done.svg).toContain("DONE");
    expect(done.flashing).toBe(false);
    const idle = drawAttention({ snap: snap([session({ state: "idle" })]), settings: {}, flashFrame: 0 });
    expect(idle.svg).toContain("IDLE");
    expect(idle.flashing).toBe(false);
  });

  it("skips acked sessions and disabled states", () => {
    const acked = drawAttention({ snap: snap([session({ acked: true })]), settings: {}, flashFrame: 0 });
    expect(acked.svg).toContain("QUIET");

    const disabled = drawAttention({
      snap: snap([session({ state: "turn_done" })]),
      settings: { alertTurnDone: false },
      flashFrame: 0,
    });
    expect(disabled.svg).toContain("QUIET");
  });

  it("falls through to the next alarming session when the worst is filtered out", () => {
    const sessions = [session({ sessionId: "a" }), session({ sessionId: "b", state: "idle", cwd: "/x/other" })];
    const { svg, flashing } = drawAttention({
      snap: snap(sessions),
      settings: { alertPermission: false },
      flashFrame: 0,
    });
    expect(svg).toContain("IDLE");
    expect(svg).toContain("other");
    expect(flashing).toBe(false);
  });

  it("shows the alarming-session count badge only above one", () => {
    const two = drawAttention({
      snap: snap([session({ sessionId: "a" }), session({ sessionId: "b", state: "idle" })]),
      settings: {},
      flashFrame: 0,
    });
    expect(two.svg).toContain(">2<");
    const one = drawAttention({ snap: snap([session({})]), settings: {}, flashFrame: 0 });
    expect(one.svg).not.toContain(">1<");
  });
});
