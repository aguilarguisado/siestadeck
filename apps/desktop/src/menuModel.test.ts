import { describe, expect, it } from "vitest";
import type { Account, QuotaSnapshot } from "@siesta/core";

import { UNKNOWN } from "./format.js";
import { buildMenuModel, type MenuActionId, type MenuInput, type MenuRow } from "./menuModel.js";

const NOW = new Date("2026-09-17T12:00:00Z");
const inSeconds = (s: number) => new Date(NOW.getTime() + s * 1000);

function account(slug: string, overrides: Partial<Account> = {}): Account {
  return {
    slug,
    displayName: slug,
    email: `${slug}@example.com`,
    tier: "max",
    rateLimitTier: "max_20x",
    color: "#B5483A",
    addedAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function snapshot(overrides: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return {
    slug: null,
    fiveHour: { utilization: 0.18, resetsAt: inSeconds(75 * 60) },
    sevenDay: { utilization: 0.76, resetsAt: inSeconds(2 * 86400 + 3 * 3600) },
    perModel: { fable: { utilization: 0.85, resetsAt: inSeconds(2 * 86400 + 3 * 3600) } },
    fetchedAt: NOW,
    cooldownUntil: null,
    ...overrides,
  };
}

function build(overrides: Partial<MenuInput> = {}) {
  return buildMenuModel({
    snapshot: snapshot(),
    accounts: [account("juan")],
    activeSlug: "juan",
    now: NOW,
    ...overrides,
  });
}

const labels = (rows: MenuRow[]) => rows.map((r) => (r.kind === "separator" ? "---" : r.label));
const infoLabels = (rows: MenuRow[]) => rows.filter((r) => r.kind === "info").map((r) => r.label);
function action(rows: MenuRow[], id: MenuActionId) {
  const row = rows.find((r) => r.kind === "action" && r.id === id);
  if (row?.kind !== "action") throw new Error(`no ${id} row`);
  return row;
}

describe("buildMenuModel", () => {
  it("lays out the five things: three windows, account, login, refresh, quit", () => {
    expect(labels(build().rows)).toEqual([
      "5h · 18% · resets in 1h 15m",
      "7d · 76% · resets in 2d 3h",
      "Fable · 85% · resets in 2d 3h",
      "---",
      "Account: juan",
      "Log in to Claude…",
      "---",
      "Refresh",
      "Quit Siesta",
    ]);
  });

  it("puts the active account's display name on the swap row", () => {
    const rows = build({
      accounts: [account("work", { displayName: "Work" }), account("home", { displayName: "Home" })],
      activeSlug: "home",
    }).rows;
    expect(action(rows, "swap").label).toBe("Account: Home");
  });

  it("drops the resets clause when a window has no reset time", () => {
    const rows = build({ snapshot: snapshot({ fiveHour: { utilization: 0.18, resetsAt: null } }) }).rows;
    expect(infoLabels(rows)[0]).toBe("5h · 18%");
  });

  it("keeps the Fable row when the account has no Fable window", () => {
    const rows = build({ snapshot: snapshot({ perModel: {} }) }).rows;
    expect(infoLabels(rows)[2]).toBe(`Fable · ${UNKNOWN}`);
  });

  it("reads every window as unknown before the first fetch", () => {
    const rows = build({ snapshot: undefined }).rows;
    expect(infoLabels(rows)).toEqual([`5h · ${UNKNOWN}`, `7d · ${UNKNOWN}`, `Fable · ${UNKNOWN}`]);
  });

  describe("tray title", () => {
    it("is the 5h percentage", () => {
      expect(build().trayTitle).toBe("18%");
    });

    it("is unknown before the first fetch", () => {
      expect(build({ snapshot: undefined }).trayTitle).toBe(UNKNOWN);
    });

    it("is unknown while signed out, rather than a stale number nobody questions", () => {
      const snap = snapshot({ cooldownUntil: inSeconds(1800), cooldownReason: "auth" });
      expect(build({ snapshot: snap }).trayTitle).toBe(UNKNOWN);
    });

    it("keeps showing the last numbers while rate limited", () => {
      const snap = snapshot({ cooldownUntil: inSeconds(47), cooldownReason: "rate" });
      expect(build({ snapshot: snap }).trayTitle).toBe("18%");
    });
  });

  describe("signed out (auth cooldown)", () => {
    const snap = snapshot({ cooldownUntil: inSeconds(1800), cooldownReason: "auth" });

    it("replaces the quota rows with one prompt", () => {
      expect(infoLabels(build({ snapshot: snap }).rows)).toEqual([
        "Signed out — Claude Code needs to sign in again",
      ]);
    });

    it("does not count down the 30-minute backoff, which a sign-in can end early", () => {
      const rows = build({ snapshot: snap }).rows;
      expect(infoLabels(rows).join(" ")).not.toMatch(/\d+m|\d+s|retry/);
    });

    it("leaves the login row as the way out", () => {
      expect(action(build({ snapshot: snap }).rows, "login").enabled).toBe(true);
    });
  });

  describe("rate limited (429 cooldown)", () => {
    it("keeps the stale numbers and adds the wait", () => {
      const snap = snapshot({ cooldownUntil: inSeconds(47), cooldownReason: "rate" });
      expect(infoLabels(build({ snapshot: snap }).rows)).toEqual([
        "5h · 18% · resets in 1h 15m",
        "7d · 76% · resets in 2d 3h",
        "Fable · 85% · resets in 2d 3h",
        "Rate limited — retry in 47s",
      ]);
    });

    it("says so without a wait when the cooldown rounds away", () => {
      // cooldownUntil in the future but under a second: still cooling, nothing
      // useful left to count.
      const snap = snapshot({ cooldownUntil: new Date(NOW.getTime() + 500), cooldownReason: "rate" });
      expect(infoLabels(build({ snapshot: snap }).rows).at(-1)).toBe("Rate limited");
    });
  });

  it("ignores a cooldown that has already expired", () => {
    const snap = snapshot({ cooldownUntil: inSeconds(-1), cooldownReason: "auth" });
    const rows = build({ snapshot: snap }).rows;
    expect(infoLabels(rows)[0]).toBe("5h · 18% · resets in 1h 15m");
  });

  describe("the swap row", () => {
    it("is disabled with no accounts, and names the absence", () => {
      const rows = build({ accounts: [], activeSlug: null }).rows;
      expect(action(rows, "swap")).toMatchObject({ label: "Account: none", enabled: false });
    });

    it("is disabled when the only account is already active", () => {
      expect(action(build().rows, "swap").enabled).toBe(false);
    });

    it("is enabled once there is somewhere to go", () => {
      const rows = build({
        accounts: [account("a"), account("b", { addedAt: "2026-02-01T00:00:00.000Z" })],
        activeSlug: "a",
      }).rows;
      expect(action(rows, "swap").enabled).toBe(true);
    });

    it("falls back to the placeholder when the active slug is dangling", () => {
      const rows = build({ accounts: [account("a")], activeSlug: "gone" }).rows;
      expect(action(rows, "swap").label).toBe(`Account: ${UNKNOWN}`);
    });
  });

  it("always offers refresh and quit", () => {
    const rows = build({ snapshot: undefined, accounts: [], activeSlug: null }).rows;
    expect(action(rows, "refresh").enabled).toBe(true);
    expect(action(rows, "quit").enabled).toBe(true);
  });
});
