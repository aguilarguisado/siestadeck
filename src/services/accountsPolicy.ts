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
};

/**
 * Detect cross-wired stashes left behind by the old bug, where one account's
 * stash was overwritten with another account's credentials. Two accounts
 * sharing the same access token is unambiguous corruption (distinct accounts
 * never share tokens; the registry de-dupes by email so the same account never
 * appears twice).
 *
 * For each duplicate group we keep the account whose recorded email matches the
 * token's true owner (resolved out-of-band via `/profile`, passed in
 * `resolvedOwnerByToken`) and flag the rest. If the token's owner can't be
 * resolved (expired/offline), the whole group is flagged — we can't safely
 * attribute it.
 *
 * Pure and deterministic given the input order.
 */
export function detectCorruptedStashes(
  entries: StashEntry[],
  resolvedOwnerByToken: Record<string, string | null>,
): CorruptionVerdict {
  const flag: string[] = [];
  const keep: string[] = [];

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
      for (const g of group) flag.push(g.slug);
      continue;
    }
    let kept = false;
    for (const g of group) {
      if (!kept && sameEmail(g.email, trueEmail)) {
        keep.push(g.slug);
        kept = true;
      } else {
        flag.push(g.slug);
      }
    }
  }

  return { flag, keep };
}
