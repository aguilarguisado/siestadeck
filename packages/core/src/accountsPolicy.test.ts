import { describe, expect, it } from "vitest";

import {
  ACCOUNT_PALETTE,
  colorForIndex,
  decideCredsSource,
  detectCorruptedStashes,
  liveOutranksStash,
  pickNextSlug,
  preferLiveOverStash,
  registryFingerprint,
  sameEmail,
  SOFT_ACCOUNT_LIMIT,
  stableOrder,
  type Orderable,
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

describe("liveOutranksStash", () => {
  const base = { liveToken: "live", liveExpiresAt: 2000, stashToken: "stash", stashExpiresAt: 1000 };

  it("prefers a live entry that outlives the stash", () => {
    expect(liveOutranksStash(base)).toBe(true);
  });

  it("declines when there are no live creds", () => {
    expect(liveOutranksStash({ ...base, liveToken: null })).toBe(false);
  });

  it("declines when both hold the same token", () => {
    expect(liveOutranksStash({ ...base, stashToken: "live" })).toBe(false);
  });

  it("declines when the stash is the fresher of the two", () => {
    expect(liveOutranksStash({ ...base, liveExpiresAt: 500 })).toBe(false);
  });

  it("declines on a tie, leaving the swap semantics untouched", () => {
    expect(liveOutranksStash({ ...base, liveExpiresAt: 1000 })).toBe(false);
  });

  it("prefers live when the account has no stash at all", () => {
    expect(liveOutranksStash({ ...base, stashToken: null, stashExpiresAt: null })).toBe(true);
  });
});

describe("preferLiveOverStash", () => {
  const fresh = { liveToken: "live", liveExpiresAt: 2000, stashToken: "stash", stashExpiresAt: 1000 };

  it("keeps a fresher live entry confirmed to belong to the swap target", () => {
    expect(
      preferLiveOverStash({ ...fresh, confirmedLiveEmail: "ADA@example.com", accountEmail: "ada@example.com" }),
    ).toBe(true);
  });

  it("never keeps another account's credential, however fresh", () => {
    expect(
      preferLiveOverStash({ ...fresh, confirmedLiveEmail: "other@example.com", accountEmail: "ada@example.com" }),
    ).toBe(false);
  });

  it("never keeps an unconfirmable live entry — identity is proved, not assumed", () => {
    expect(
      preferLiveOverStash({ ...fresh, confirmedLiveEmail: null, accountEmail: "ada@example.com" }),
    ).toBe(false);
  });

  it("swaps the stash in when it is not the staler credential", () => {
    expect(
      preferLiveOverStash({
        ...fresh,
        liveExpiresAt: 100,
        confirmedLiveEmail: "ada@example.com",
        accountEmail: "ada@example.com",
      }),
    ).toBe(false);
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
    expect(verdict.unresolved).toEqual([]);
  });

  it("keeps the true owner of a shared token and flags the rest", () => {
    const entries: StashEntry[] = [
      { slug: "a", token: "shared", email: "a@x.com" },
      { slug: "b", token: "shared", email: "b@x.com" },
    ];
    const verdict = detectCorruptedStashes(entries, { shared: "b@x.com" });
    expect(verdict.keep).toEqual(["b"]);
    expect(verdict.flag).toEqual(["a"]);
    expect(verdict.unresolved).toEqual([]);
  });

  it("never flags a group whose owner can't be resolved — offline is not corruption", () => {
    const entries: StashEntry[] = [
      { slug: "a", token: "shared", email: "a@x.com" },
      { slug: "b", token: "shared", email: "b@x.com" },
    ];
    for (const resolved of [{}, { shared: null }]) {
      const verdict = detectCorruptedStashes(entries, resolved);
      expect(verdict.flag).toEqual([]);
      expect(verdict.keep).toEqual([]);
      expect(verdict.unresolved).toEqual(["a", "b"]);
    }
  });

  it("flags the whole group when no member claims the resolved owner email", () => {
    const entries: StashEntry[] = [
      { slug: "a", token: "shared", email: "a@x.com" },
      { slug: "b", token: "shared", email: "b@x.com" },
    ];
    const verdict = detectCorruptedStashes(entries, { shared: "c@x.com" });
    expect(verdict.flag).toEqual(["a", "b"]);
    expect(verdict.keep).toEqual([]);
    expect(verdict.unresolved).toEqual([]);
  });

  it("treats accounts with no stash as fine (never corrupt)", () => {
    const entries: StashEntry[] = [
      { slug: "a", token: null, email: "a@x.com" },
      { slug: "b", token: "tb", email: "b@x.com" },
    ];
    const verdict = detectCorruptedStashes(entries, {});
    expect(verdict.flag).toEqual([]);
    expect(verdict.keep).toEqual(["a", "b"]);
    expect(verdict.unresolved).toEqual([]);
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

  it("resolves a three-way group without collateral damage", () => {
    const entries: StashEntry[] = [
      { slug: "a", token: "shared", email: "a@x.com" },
      { slug: "b", token: "shared", email: "b@x.com" },
      { slug: "c", token: "shared", email: "c@x.com" },
      { slug: "d", token: "own", email: "d@x.com" },
    ];
    const verdict = detectCorruptedStashes(entries, { shared: "c@x.com" });
    expect(verdict.keep).toEqual(["c", "d"]);
    expect(verdict.flag).toEqual(["a", "b"]);
    expect(verdict.unresolved).toEqual([]);
  });
});

const acct = (slug: string, addedAt: string): Orderable => ({ slug, addedAt });

describe("stableOrder", () => {
  it("sorts oldest first by addedAt", () => {
    const out = stableOrder([
      acct("c", "2026-03-01T00:00:00Z"),
      acct("a", "2026-01-01T00:00:00Z"),
      acct("b", "2026-02-01T00:00:00Z"),
    ]);
    expect(out.map((a) => a.slug)).toEqual(["a", "b", "c"]);
  });

  it("breaks addedAt ties by slug so the order is total", () => {
    const same = "2026-01-01T00:00:00Z";
    const out = stableOrder([acct("zeta", same), acct("alpha", same), acct("mid", same)]);
    expect(out.map((a) => a.slug)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("does not mutate its input", () => {
    const input = [acct("b", "2026-02-01T00:00:00Z"), acct("a", "2026-01-01T00:00:00Z")];
    stableOrder(input);
    expect(input.map((a) => a.slug)).toEqual(["b", "a"]);
  });

  it("tolerates an empty registry", () => {
    expect(stableOrder([])).toEqual([]);
  });

  it("keeps a total order when a hand-edited row has no addedAt", () => {
    const rows = [
      acct("dated", "2026-01-01T00:00:00Z"),
      { slug: "undated" } as Orderable, // registry rows are JSON.parse'd, not validated
    ];
    expect(stableOrder(rows).map((a) => a.slug)).toEqual(["undated", "dated"]);
    expect(pickNextSlug(rows, "undated")).toBe("dated");
    expect(pickNextSlug(rows, "dated")).toBe("undated");
  });
});

describe("pickNextSlug", () => {
  const three = [
    acct("b", "2026-02-01T00:00:00Z"),
    acct("c", "2026-03-01T00:00:00Z"),
    acct("a", "2026-01-01T00:00:00Z"),
  ]; // deliberately shuffled: the picker must impose its own order

  it("cycles through every account and wraps — the three-account bug", () => {
    expect(pickNextSlug(three, "a")).toBe("b");
    expect(pickNextSlug(three, "b")).toBe("c");
    expect(pickNextSlug(three, "c")).toBe("a");
  });

  it("visits all 20 accounts of a soft-limit-sized registry in one lap", () => {
    const many = Array.from({ length: SOFT_ACCOUNT_LIMIT }, (_, i) =>
      acct(`acct-${i}`, `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`),
    );
    const seen = new Set<string>();
    let cur: string | null = "acct-0";
    for (let i = 0; i < SOFT_ACCOUNT_LIMIT; i++) {
      seen.add(cur!);
      cur = pickNextSlug(many, cur);
    }
    expect(seen.size).toBe(SOFT_ACCOUNT_LIMIT);
    expect(cur).toBe("acct-0"); // wrapped exactly once
  });

  it("has no ceiling — cycles a registry well past the soft limit", () => {
    const many = Array.from({ length: 57 }, (_, i) =>
      acct(`a${String(i).padStart(3, "0")}`, `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`),
    );
    expect(pickNextSlug(many, "a020")).toBe("a021");
    expect(pickNextSlug(many, "a056")).toBe("a000");
  });

  it("returns null when the press would be a no-op", () => {
    expect(pickNextSlug([], null)).toBeNull();
    expect(pickNextSlug([], "a")).toBeNull();
    expect(pickNextSlug([acct("a", "2026-01-01T00:00:00Z")], "a")).toBeNull();
  });

  it("recovers a lost or dangling selection by picking the first account", () => {
    expect(pickNextSlug(three, null)).toBe("a");
    expect(pickNextSlug(three, "deleted-slug")).toBe("a");
    expect(pickNextSlug([acct("solo", "2026-01-01T00:00:00Z")], null)).toBe("solo");
  });

  it("still visits everyone when addedAt timestamps collide", () => {
    const same = "2026-01-01T00:00:00Z";
    const tied = [acct("b", same), acct("a", same), acct("c", same)];
    expect(pickNextSlug(tied, "a")).toBe("b");
    expect(pickNextSlug(tied, "b")).toBe("c");
    expect(pickNextSlug(tied, "c")).toBe("a");
  });
});

describe("account palette", () => {
  it("covers the soft limit", () => {
    expect(ACCOUNT_PALETTE).toHaveLength(SOFT_ACCOUNT_LIMIT);
  });

  it("pins the original six colors in place so existing accounts never repaint", () => {
    expect(ACCOUNT_PALETTE.slice(0, 6)).toEqual([
      "#D0776C", "#F2C744", "#E5534B", "#E0A458", "#E5A38A", "#B5483A",
    ]);
  });

  it("has no duplicate colors", () => {
    expect(new Set(ACCOUNT_PALETTE).size).toBe(ACCOUNT_PALETTE.length);
  });

  it("wraps past the end instead of running out", () => {
    expect(colorForIndex(0)).toBe(ACCOUNT_PALETTE[0]);
    expect(colorForIndex(SOFT_ACCOUNT_LIMIT)).toBe(ACCOUNT_PALETTE[0]);
    expect(colorForIndex(SOFT_ACCOUNT_LIMIT + 3)).toBe(ACCOUNT_PALETTE[3]);
  });
});

describe("registryFingerprint", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    slug: "ada",
    displayName: "Ada",
    email: "ada@example.com",
    tier: "max",
    rateLimitTier: "default",
    color: "#D0776C",
    addedAt: "2026-01-01T00:00:00Z",
    lastUsedAt: "2026-01-01T00:00:00Z",
    ...over,
  });

  it("ignores key order, so a document parsed from disk matches one built here", () => {
    // The whole point: reload() compares a document another app wrote against a
    // graph this process constructed. Key order is an accident of how each was
    // built — and a sibling app on a different build may well write its keys in
    // another order — so it must not read as a change.
    const built = { accounts: [row()], activeSlug: "ada" };
    const reversed = Object.fromEntries(Object.entries(row()).reverse());
    expect(Object.keys(reversed)).not.toEqual(Object.keys(row())); // guard the guard
    expect(registryFingerprint({ accounts: [reversed], activeSlug: "ada" })).toBe(
      registryFingerprint(built),
    );
  });

  it("ignores fields a newer sibling app added that this build doesn't know", () => {
    // writeRegistry round-trips the parsed document, so unknown fields survive.
    // They must not make every reload() look like a change.
    const base = { accounts: [row()], activeSlug: "ada" };
    const extended = { accounts: [row({ favouriteColour: "blue" })], activeSlug: "ada" };
    expect(registryFingerprint(extended)).toBe(registryFingerprint(base));
  });

  it("notices a lastUsedAt change — a swap to the already-active account moves nothing else", () => {
    // If lastUsedAt were left out of the stamp, that swap would fingerprint as
    // unchanged and silently fail to persist.
    const before = { accounts: [row()], activeSlug: "ada" };
    const after = { accounts: [row({ lastUsedAt: "2026-06-01T00:00:00Z" })], activeSlug: "ada" };
    expect(registryFingerprint(after)).not.toBe(registryFingerprint(before));
  });

  it("notices every field that is written back to disk", () => {
    const base = { accounts: [row()], activeSlug: "ada" };
    for (const [field, value] of Object.entries({
      slug: "ada-2",
      displayName: "Ada L",
      email: "ada@other.com",
      tier: "pro",
      rateLimitTier: "high",
      color: "#F2C744",
      addedAt: "2027-01-01T00:00:00Z",
    })) {
      const changed = { accounts: [row({ [field]: value })], activeSlug: "ada" };
      expect(registryFingerprint(changed), field).not.toBe(registryFingerprint(base));
    }
  });

  it("notices a selection change", () => {
    const a = { accounts: [row()], activeSlug: "ada" };
    const b = { accounts: [row()], activeSlug: null };
    expect(registryFingerprint(a)).not.toBe(registryFingerprint(b));
  });

  it("treats a reorder as a change, because colors are assigned by position", () => {
    // reconcilePaletteColors repaints by array index, so a pure reorder really
    // does change what the registry will do next. Do NOT sort before stamping.
    const ada = row({ slug: "ada" });
    const bob = row({ slug: "bob" });
    const one = { accounts: [ada, bob], activeSlug: null };
    const two = { accounts: [bob, ada], activeSlug: null };
    expect(registryFingerprint(one)).not.toBe(registryFingerprint(two));
  });

  it("survives a malformed document instead of throwing", () => {
    // readJsonOr does no validation, and this helper is now the first thing to
    // touch every document on every path — including a hand-edited one.
    expect(() => registryFingerprint({ accounts: null, activeSlug: null })).not.toThrow();
    expect(() => registryFingerprint({ accounts: [null], activeSlug: null })).not.toThrow();
    expect(() => registryFingerprint({ accounts: "nope", activeSlug: null })).not.toThrow();
    expect(registryFingerprint({ accounts: null, activeSlug: null })).toBe(
      registryFingerprint({ accounts: [], activeSlug: null }),
    );
  });
});
