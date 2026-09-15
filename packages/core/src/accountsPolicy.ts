// Pure helpers extracted from AccountsService. No I/O, no SDK refs, no network —
// fully unit-testable. The class in accounts.ts wires these into its keychain /
// /profile I/O.
//
// Background: account identity (which Anthropic account a credential blob
// belongs to) is NOT derivable offline — the stored creds hold only opaque
// access/refresh tokens. The only identity source is a network call to
// `/api/oauth/profile`, which returns an email. These deciders take the
// already-fetched email(s) as inputs so the policy itself stays pure.

/** Case-insensitive, whitespace-trimmed email equality. Nullish never matches. */
export function sameEmail(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export type CredsSource = "live" | "stash";

/**
 * Decide whether the *selected* account's credentials should come from the live
 * `Claude Code-credentials` entry or from the account's own per-account stash.
 *
 * The live entry is shared with the running Claude Code process and can hold a
 * DIFFERENT account's tokens than the one Siesta has selected (e.g. you swapped
 * in Siesta but didn't restart Claude Code, so it rotated its own token back
 * into the entry). We only trust the live entry when we can prove it belongs to
 * the selected account:
 *
 *  - identical access tokens → the live entry IS this account's creds (we wrote
 *    or mirrored it) → "live", no network confirmation needed.
 *  - tokens differ → the live entry changed under us; trust it only if a
 *    network `/profile` lookup confirms its email matches the selected account.
 *  - otherwise (no live creds, unconfirmable, or a confirmed mismatch) → fall
 *    back to the account's own stash and DO NOT mirror.
 */
export function decideCredsSource(input: {
  liveToken: string | null;
  stashToken: string | null;
  /** Email resolved from the live token via /profile; null/undefined = unconfirmed. */
  confirmedLiveEmail?: string | null;
  /** The selected account's recorded email. */
  accountEmail?: string | null;
}): CredsSource {
  const { liveToken, stashToken, confirmedLiveEmail, accountEmail } = input;
  if (!liveToken) return "stash";
  if (stashToken != null && liveToken === stashToken) return "live";
  if (sameEmail(confirmedLiveEmail, accountEmail)) return "live";
  return "stash";
}

export type CredsFreshness = {
  liveToken: string | null;
  liveExpiresAt: number | null;
  stashToken: string | null;
  stashExpiresAt: number | null;
};

/**
 * Freshness half of the swap decision: does the live `Claude Code-credentials`
 * entry outlive this account's stash? Says nothing about *whose* entry it is.
 *
 * Split out from `preferLiveOverStash` because identity is the expensive half —
 * it costs a `/profile` round-trip — and this half disqualifies the live entry
 * for free in the common case.
 */
export function liveOutranksStash(input: CredsFreshness): boolean {
  const { liveToken, liveExpiresAt, stashToken, stashExpiresAt } = input;
  if (!liveToken) return false;
  if (liveToken === stashToken) return false; // same credential — nothing to choose between
  return (liveExpiresAt ?? 0) > (stashExpiresAt ?? 0);
}

/**
 * Whether a swap into this account should KEEP the live
 * `Claude Code-credentials` entry rather than write the account's stash over it.
 *
 * OAuth refresh tokens are single-use. Once Claude Code has refreshed the live
 * entry, the copy in our per-account stash isn't merely older — it is *retired*,
 * and Anthropic answers it with HTTP 400. Writing that stash back over a live
 * entry that already belongs to this account therefore doesn't restore the
 * account, it revokes it: the usage call 401s, the refresh is refused, and the
 * tile parks in the 30-minute auth backoff with nothing left to recover from.
 *
 * So we keep live only when it outlives the stash AND is *provably* the same
 * account — a `/profile`-confirmed email; identity is never inferred from
 * freshness. Everything else swaps the stash in as before: for any other account
 * the live entry holds someone else's credential, and replacing it is the entire
 * point of a swap.
 */
export function preferLiveOverStash(
  input: CredsFreshness & {
    /** Email resolved from the live token via /profile; null/undefined = unconfirmed. */
    confirmedLiveEmail?: string | null;
    /** The swap target's recorded email. */
    accountEmail?: string | null;
  },
): boolean {
  if (!liveOutranksStash(input)) return false;
  return sameEmail(input.confirmedLiveEmail, input.accountEmail);
}

export type StashEntry = {
  slug: string;
  /** The account's stashed access token, or null if it has no stash. */
  token: string | null;
  /** The account's recorded email. */
  email: string | null;
};

export type CorruptionVerdict = {
  /** Slugs whose stash is a duplicate that does NOT belong to them — re-auth. */
  flag: string[];
  /** Slugs whose stash is fine (unique, empty, or the true owner of a shared token). */
  keep: string[];
  /**
   * Slugs sharing a token whose owner we could not resolve. Undecidable, not
   * innocent — the caller must leave them untouched and re-evaluate later.
   */
  unresolved: string[];
};

/**
 * Detect cross-wired stashes left behind by the old bug, where one account's
 * stash was overwritten with another account's credentials. Two accounts
 * sharing the same access token is unambiguous corruption (distinct accounts
 * never share tokens; the registry de-dupes by email so the same account never
 * appears twice).
 *
 * For each duplicate group we keep the accounts whose recorded email matches the
 * token's true owner (resolved out-of-band via `/profile`, passed in
 * `resolvedOwnerByToken`) and flag the rest.
 *
 * When the owner can't be resolved the group is reported as `unresolved`, never
 * flagged: an unreachable `/profile` (offline, 5xx, rate-limited) is a statement
 * about the network, not about the account. Flagging on a transient failure used
 * to delete both members of every duplicate group on any offline start.
 *
 * Pure and deterministic given the input order.
 */
export function detectCorruptedStashes(
  entries: StashEntry[],
  resolvedOwnerByToken: Record<string, string | null>,
): CorruptionVerdict {
  const flag: string[] = [];
  const keep: string[] = [];
  const unresolved: string[] = [];

  const byToken = new Map<string, StashEntry[]>();
  for (const e of entries) {
    if (!e.token) {
      keep.push(e.slug); // no stash → nothing to corrupt
      continue;
    }
    const group = byToken.get(e.token) ?? [];
    group.push(e);
    byToken.set(e.token, group);
  }

  for (const [token, group] of byToken) {
    if (group.length < 2) {
      keep.push(group[0]!.slug);
      continue;
    }
    const trueEmail = resolvedOwnerByToken[token] ?? null;
    if (!trueEmail) {
      for (const g of group) unresolved.push(g.slug);
      continue;
    }
    for (const g of group) {
      if (sameEmail(g.email, trueEmail)) keep.push(g.slug);
      else flag.push(g.slug);
    }
  }

  return { flag, keep, unresolved };
}

/**
 * A soft ceiling, never enforced. The registry holds as many accounts as you
 * add; this only sizes the color palette and triggers a log line so an absurd
 * registry is visible in the diagnostics. Nothing is ever refused or removed
 * for exceeding it.
 */
export const SOFT_ACCOUNT_LIMIT = 20;

/**
 * Per-account accent colors, assigned by registry position.
 *
 * The first six entries are load-bearing: colors are reassigned by index on
 * every start, so changing a value or a position here would silently repaint
 * every existing user's accounts. Append, never reorder. Warm tones first
 * (the brand palette), then cooler hues so neighbours stay distinguishable at
 * small key/icon sizes.
 */
export const ACCOUNT_PALETTE: readonly string[] = [
  "#D0776C", "#F2C744", "#E5534B", "#E0A458", "#E5A38A", "#B5483A",
  "#5B8DB8", "#6FA86B", "#8E6FB8", "#4FA3A5", "#C46FA0", "#A0A84F",
  "#B87F5B", "#5B6FB8", "#6BA88E", "#B85B8D", "#8FA05F", "#5FA0B8",
  "#B8A05B", "#7C8A99",
];

/** Accent color for the account at registry position `idx`. Wraps past the end. */
export function colorForIndex(idx: number): string {
  return ACCOUNT_PALETTE[idx % ACCOUNT_PALETTE.length]!;
}

/** The fields ordering needs; `Account` in accounts.ts satisfies it. */
export type Orderable = { slug: string; addedAt: string };

/**
 * Presentation and cycle order: oldest account first, by `addedAt` (ISO-8601
 * strings sort chronologically), tie-broken by slug.
 *
 * Deliberately NOT `lastUsedAt`: a recency sort reshuffles on every swap, which
 * makes "the next account" mean "the one I just came from" and traps the cycle
 * in a two-account loop. Order must be a property of the registry, not of the
 * last press. Does not mutate the input.
 */
export function stableOrder<T extends Orderable>(accounts: readonly T[]): T[] {
  const addedAt = (a: T): string => a.addedAt ?? ""; // registry rows come from JSON.parse
  return [...accounts].sort((a, b) => {
    if (addedAt(a) !== addedAt(b)) return addedAt(a) < addedAt(b) ? -1 : 1;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
}

/**
 * The account a "next" press should swap to: the successor of `activeSlug` in
 * stable order, wrapping at the end. Works for any number of accounts.
 *
 * Returns null when the press would be a no-op — an empty registry, or a single
 * account that is already active — so the caller can flash the tile. An
 * `activeSlug` that is null or dangling resolves to the first account, which
 * recovers a registry whose selection was lost.
 */
export function pickNextSlug(
  accounts: readonly Orderable[],
  activeSlug: string | null,
): string | null {
  const ordered = stableOrder(accounts);
  if (ordered.length === 0) return null;
  const idx = ordered.findIndex((a) => a.slug === activeSlug);
  const next = idx === -1 ? ordered[0]! : ordered[(idx + 1) % ordered.length]!;
  return next.slug === activeSlug ? null : next.slug;
}
