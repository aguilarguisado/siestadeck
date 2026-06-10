import { describe, expect, it } from "vitest";

import {
  decideCredsSource,
  detectCorruptedStashes,
  sameEmail,
  type StashEntry,
} from "./accountsPolicy.js";

describe("sameEmail", () => {
  it("is case-insensitive and trims whitespace", () => {
    expect(sameEmail("Ada@Example.com", "  ada@example.com ")).toBe(true);
  });

  it("never matches when either side is nullish or empty", () => {
    expect(sameEmail(null, "a@b.com")).toBe(false);
    expect(sameEmail("a@b.com", undefined)).toBe(false);
    expect(sameEmail("", "")).toBe(false);
  });

  it("returns false for genuinely different emails", () => {
    expect(sameEmail("a@b.com", "c@d.com")).toBe(false);
  });
});

describe("decideCredsSource", () => {
  it("falls back to stash when there are no live creds", () => {
    expect(
      decideCredsSource({ liveToken: null, stashToken: "s", accountEmail: "a@b.com" }),
    ).toBe("stash");
  });

  it("trusts live when the access tokens are identical (no confirmation needed)", () => {
    expect(
      decideCredsSource({ liveToken: "same", stashToken: "same" }),
    ).toBe("live");
  });

  it("trusts live when a different token is confirmed to the selected account", () => {
    expect(
      decideCredsSource({
        liveToken: "rotated",
        stashToken: "old",
        confirmedLiveEmail: "ada@example.com",
        accountEmail: "ADA@example.com",
      }),
    ).toBe("live");
  });

  it("falls back to stash when a different token belongs to another account", () => {
    expect(
      decideCredsSource({
        liveToken: "foreign",
        stashToken: "mine",
        confirmedLiveEmail: "other@example.com",
        accountEmail: "mine@example.com",
      }),
    ).toBe("stash");
  });

  it("falls back to stash when identity cannot be confirmed", () => {
    expect(
      decideCredsSource({
        liveToken: "rotated",
        stashToken: "old",
        confirmedLiveEmail: null,
        accountEmail: "mine@example.com",
      }),
    ).toBe("stash");
  });

  it("can adopt confirmed live creds even with no prior stash", () => {
    expect(
      decideCredsSource({
        liveToken: "fresh",
        stashToken: null,
        confirmedLiveEmail: "a@b.com",
        accountEmail: "a@b.com",
      }),
    ).toBe("live");
  });
});

describe("detectCorruptedStashes", () => {
  it("flags nothing when every token is unique", () => {
    const entries: StashEntry[] = [
      { slug: "a", token: "ta", email: "a@x.com" },
      { slug: "b", token: "tb", email: "b@x.com" },
    ];
    const verdict = detectCorruptedStashes(entries, {});
    expect(verdict.flag).toEqual([]);
    expect(verdict.keep).toEqual(["a", "b"]);
  });

  it("keeps the true owner of a shared token and flags the rest", () => {
    const entries: StashEntry[] = [
      { slug: "a", token: "shared", email: "a@x.com" },
      { slug: "b", token: "shared", email: "b@x.com" },
    ];
    const verdict = detectCorruptedStashes(entries, { shared: "b@x.com" });
    expect(verdict.keep).toEqual(["b"]);
    expect(verdict.flag).toEqual(["a"]);
  });

  it("flags the whole group when the token owner can't be resolved", () => {
    const entries: StashEntry[] = [
      { slug: "a", token: "shared", email: "a@x.com" },
      { slug: "b", token: "shared", email: "b@x.com" },
    ];
    expect(detectCorruptedStashes(entries, {}).flag).toEqual(["a", "b"]);
    expect(detectCorruptedStashes(entries, { shared: null }).flag).toEqual(["a", "b"]);
  });

  it("flags the whole group when no member claims the resolved owner email", () => {
    const entries: StashEntry[] = [
      { slug: "a", token: "shared", email: "a@x.com" },
      { slug: "b", token: "shared", email: "b@x.com" },
    ];
    const verdict = detectCorruptedStashes(entries, { shared: "c@x.com" });
    expect(verdict.flag).toEqual(["a", "b"]);
    expect(verdict.keep).toEqual([]);
  });

  it("treats accounts with no stash as fine (never corrupt)", () => {
    const entries: StashEntry[] = [
      { slug: "a", token: null, email: "a@x.com" },
      { slug: "b", token: "tb", email: "b@x.com" },
    ];
    const verdict = detectCorruptedStashes(entries, {});
    expect(verdict.flag).toEqual([]);
    expect(verdict.keep).toEqual(["a", "b"]);
  });

  it("matches the owner case-insensitively", () => {
    const entries: StashEntry[] = [
      { slug: "a", token: "shared", email: "Owner@X.com" },
      { slug: "b", token: "shared", email: "b@x.com" },
    ];
    const verdict = detectCorruptedStashes(entries, { shared: "owner@x.com" });
    expect(verdict.keep).toEqual(["a"]);
    expect(verdict.flag).toEqual(["b"]);
  });
});
