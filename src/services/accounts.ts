import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";

import streamDeck from "@elgato/streamdeck";

import {
  readClaudeCredentials,
  readGenericPassword,
  snapshotClaudeCredentials,
  writeClaudeCredentials,
  writeGenericPassword,
  type ClaudeCredentials,
} from "./keychain.js";
import {
  decideCredsSource,
  detectCorruptedStashes,
  sameEmail,
  type CredsSource,
  type StashEntry,
} from "./accountsPolicy.js";
import { refreshOAuthToken } from "./oauthRefresh.js";
import {
  accountsRegistryDir as REGISTRY_DIR,
  accountsRegistryJson as REGISTRY_PATH,
} from "./paths.js";
import { notify } from "./terminal.js";

export const PLUGIN_KEYCHAIN_PREFIX = "siestadeck-token";

const PALETTE = ["#D0776C", "#F2C744", "#E5534B", "#E0A458", "#E5A38A", "#B5483A"];

export type Account = {
  slug: string;
  displayName: string;
  email: string;
  tier: string;
  rateLimitTier: string;
  color: string;
  addedAt: string;
  lastUsedAt: string;
};

type Registry = { accounts: Account[]; activeSlug: string | null };

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "account";
}

async function readRegistry(): Promise<Registry> {
  try {
    const raw = await fs.readFile(REGISTRY_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return { accounts: [], activeSlug: null };
  }
}

async function writeRegistry(reg: Registry): Promise<void> {
  await fs.mkdir(REGISTRY_DIR, { recursive: true });
  await fs.writeFile(REGISTRY_PATH, JSON.stringify(reg, null, 2));
}

function keychainServiceFor(slug: string): string {
  return `${PLUGIN_KEYCHAIN_PREFIX}-${slug}`;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class AccountsService extends EventEmitter {
  private registry: Registry = { accounts: [], activeSlug: null };
  private pollTimer?: NodeJS.Timeout;
  /**
   * Memoizes `email` resolved from an access token via `/profile`, so identity
   * confirmation costs at most one network call per distinct token. Only
   * *definitive* results are cached (a confirmed email, or an authoritative
   * "no email for this token"); transient failures are never cached so a later
   * tick retries instead of pinning the token to "unconfirmable". Cleared
   * whenever credentials change under us (swap / adopt / capture), and bounded
   * to EMAIL_MEMO_CAP so a long-lived process can't accumulate stale tokens.
   */
  private emailMemo = new Map<string, string | null>();
  private static readonly EMAIL_MEMO_CAP = 16;

  async start(): Promise<void> {
    this.registry = await readRegistry();
    await this.reconcilePaletteColors();
    await this.removeCrossWiredStashes();
    await this.adoptCurrentLogin({ intent: "passive" });
    this.emit("changed");
  }

  private async reconcilePaletteColors(): Promise<void> {
    let changed = false;
    this.registry.accounts.forEach((acc, idx) => {
      const target = PALETTE[idx % PALETTE.length]!;
      if (acc.color !== target) {
        acc.color = target;
        changed = true;
      }
    });
    if (changed) await writeRegistry(this.registry);
  }

  list(): Account[] {
    return [...this.registry.accounts].sort((a, b) =>
      a.lastUsedAt < b.lastUsedAt ? 1 : a.lastUsedAt > b.lastUsedAt ? -1 : 0,
    );
  }

  get activeSlug(): string | null {
    return this.registry.activeSlug;
  }

  get(slug: string): Account | undefined {
    return this.registry.accounts.find((a) => a.slug === slug);
  }

  async getAccessToken(slug: string): Promise<string | null> {
    const { creds } = await this.resolveCreds(slug);
    return creds?.claudeAiOauth?.accessToken ?? null;
  }

  private async readStash(slug: string): Promise<ClaudeCredentials | null> {
    try {
      const raw = await readGenericPassword(keychainServiceFor(slug));
      return JSON.parse(raw) as ClaudeCredentials;
    } catch {
      return null;
    }
  }

  /**
   * Memoized `/profile` email lookup — at most one network call per token.
   * A transient `/profile` failure (network error, 5xx, 429) surfaces as a
   * throw from `fetchEmail` and is deliberately NOT cached: we return null for
   * this call but leave the memo empty so the next tick can retry.
   */
  private async resolveEmail(token: string): Promise<string | null> {
    if (this.emailMemo.has(token)) return this.emailMemo.get(token) ?? null;
    let email: string | null;
    try {
      email = await this.fetchEmail(token);
    } catch {
      return null; // transient — don't memoize, retry later
    }
    this.rememberEmail(token, email);
    return email;
  }

  /** Cache a definitive email result, evicting the oldest entry past the cap. */
  private rememberEmail(token: string, email: string | null): void {
    if (this.emailMemo.size >= AccountsService.EMAIL_MEMO_CAP && !this.emailMemo.has(token)) {
      const oldest = this.emailMemo.keys().next().value;
      if (oldest !== undefined) this.emailMemo.delete(oldest);
    }
    this.emailMemo.set(token, email);
  }

  /**
   * Resolve the credentials to use for `slug`, and report where they came from.
   *
   * The live `Claude Code-credentials` entry is shared with the running Claude
   * Code process, which can rotate a DIFFERENT account's token into it (e.g.
   * you swapped in Siesta but didn't restart Claude Code). So for the active
   * (Siesta-selected) account we use the live entry only when it's provably
   * ours: identical access token, or a memoized `/profile` lookup confirming
   * its email. Otherwise — and for every inactive slug — we use the account's
   * own stash.
   *
   * Side effect: when the live entry is confirmed ours and fresher than the
   * stash, we mirror it back so a later swap restores current credentials.
   */
  private async resolveCreds(
    slug: string,
  ): Promise<{ creds: ClaudeCredentials | null; source: CredsSource | "none" }> {
    const acct = this.get(slug);
    const stash = await this.readStash(slug);
    const stashToken = stash?.claudeAiOauth.accessToken ?? null;

    if (slug === this.registry.activeSlug) {
      let live: ClaudeCredentials | null = null;
      try {
        live = await readClaudeCredentials();
      } catch {
        live = null;
      }
      if (live) {
        const liveToken = live.claudeAiOauth.accessToken;
        let confirmedLiveEmail: string | null | undefined;
        if (stashToken == null || liveToken !== stashToken) {
          confirmedLiveEmail = await this.resolveEmail(liveToken);
        }
        const source = decideCredsSource({
          liveToken,
          stashToken,
          confirmedLiveEmail,
          accountEmail: acct?.email ?? null,
        });
        if (source === "live") {
          await this.mirrorIntoStash(slug, live, stashToken);
          return { creds: live, source: "live" };
        }
      }
    }

    return { creds: stash, source: stash ? "stash" : "none" };
  }

  private async mirrorIntoStash(
    slug: string,
    live: ClaudeCredentials,
    stashToken: string | null,
  ): Promise<void> {
    if (stashToken === live.claudeAiOauth.accessToken) return;
    try {
      await this.stashCreds(slug, live);
    } catch (err) {
      streamDeck.logger.warn(`accounts[${slug}]: mirror-back failed: ${describeError(err)}`);
    }
  }

  /**
   * Mint a fresh access_token for `slug` by redeeming its freshest available
   * refresh_token against Anthropic's OAuth endpoint, then write the result
   * back to the per-account stash — and to the live `Claude Code-credentials`
   * entry only when that entry is confirmed to belong to this account
   * (`source === "live"`). Refreshing an account whose live entry belongs to a
   * different account updates the stash alone, so we never clobber the token a
   * running Claude Code is using.
   *
   * Returns true on success, false otherwise. Failure reasons are logged so
   * the 30-minute auth-expired backoff (`UNAUTHORIZED_BACKOFF_MS`) is never
   * a black box.
   */
  async refreshTokenFor(slug: string): Promise<boolean> {
    if (slug === "__bootstrap__") return false;
    const { creds, source } = await this.resolveCreds(slug);
    const oauth = creds?.claudeAiOauth;
    if (!oauth?.refreshToken) {
      streamDeck.logger.warn(`accounts[${slug}]: refresh skipped — no usable refresh_token`);
      return false;
    }
    let refreshed;
    try {
      refreshed = await refreshOAuthToken(oauth.refreshToken);
    } catch (err) {
      streamDeck.logger.warn(`accounts[${slug}]: refresh rejected by Anthropic (${source}): ${describeError(err)}`);
      return false;
    }
    const next: ClaudeCredentials = {
      claudeAiOauth: {
        ...oauth,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
      },
    };
    try {
      await this.stashCreds(slug, next);
      // Only write back to the live entry when it currently belongs to this
      // account (source === "live"). Otherwise we'd clobber a different
      // account's live credentials that Claude Code is actively using.
      if (source === "live") {
        this.emailMemo.delete(oauth.accessToken);
        await writeClaudeCredentials(os.userInfo().username, JSON.stringify(next));
      }
    } catch (err) {
      streamDeck.logger.warn(`accounts[${slug}]: refresh write-back failed: ${describeError(err)}`);
      return false;
    }
    return true;
  }

  /** True when `activeSlug` points at an account that still exists. */
  private hasValidSelection(): boolean {
    return this.registry.activeSlug != null && this.get(this.registry.activeSlug) != null;
  }

  /**
   * Read whatever credentials Claude Code currently has and merge them into our
   * registry. The credentials always belong to the matched email, so re-stashing
   * onto that account is safe and keeps it current.
   *
   * Whether this *changes the selection* depends on `intent`:
   *  - `"explicit"` — a deliberate Siesta login/add-account → always make the
   *    adopted account active.
   *  - `"passive"` — startup reconcile → only set the active account when there
   *    is no valid selection yet (genuine first run). An existing selection is
   *    sticky: Siesta keeps showing the account *you* picked even if Claude Code
   *    is currently logged in to a different one.
   *
   * Returns the resulting active slug, or null if there were no live credentials.
   */
  private async adoptCurrentLogin(opts: {
    displayName?: string;
    intent: "passive" | "explicit";
  }): Promise<string | null> {
    let creds;
    try {
      creds = await readClaudeCredentials();
    } catch {
      return null;
    }
    let email: string | null;
    try {
      email = await this.fetchEmail(creds.claudeAiOauth.accessToken);
    } catch {
      return null; // transient /profile failure — can't identify this login yet
    }
    if (!email) return null;
    this.emailMemo.clear();
    const setActive = opts.intent === "explicit" || !this.hasValidSelection();
    const existing = this.registry.accounts.find((a) => sameEmail(a.email, email));
    if (existing) {
      await this.stashCreds(existing.slug, creds);
      if (setActive) {
        this.registry.activeSlug = existing.slug;
        existing.lastUsedAt = new Date().toISOString();
      }
      await writeRegistry(this.registry);
      return this.registry.activeSlug;
    }
    const baseName = opts.displayName?.trim() || email.split("@")[0] || "account";
    const slug = this.uniqueSlug(slugify(baseName));
    const acct: Account = {
      slug,
      displayName: baseName,
      email,
      tier: creds.claudeAiOauth.subscriptionType,
      rateLimitTier: creds.claudeAiOauth.rateLimitTier,
      color: PALETTE[this.registry.accounts.length % PALETTE.length]!,
      addedAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    };
    this.registry.accounts.push(acct);
    if (setActive) this.registry.activeSlug = slug;
    await this.stashCreds(slug, creds);
    await writeRegistry(this.registry);
    return this.registry.activeSlug;
  }

  /**
   * Remove cross-wired accounts left by the old desync bug, where one account's
   * per-account stash was overwritten with another account's credentials. Two
   * accounts sharing an access token is unambiguous corruption. We keep the
   * true owner (resolved via `/profile`) and drop the rest from the registry —
   * a corrupt stash can never be made correct in place, so the cleanest remedy
   * is to log the account out of Siesta and let the user re-add it via Login,
   * which captures fresh, correct credentials.
   *
   * Clears `activeSlug` if it pointed at a removed account; the subsequent
   * passive adopt then re-selects whatever Claude Code is actually logged in to.
   */
  private async removeCrossWiredStashes(): Promise<void> {
    const entries: StashEntry[] = [];
    for (const acct of this.registry.accounts) {
      const stash = await this.readStash(acct.slug);
      entries.push({
        slug: acct.slug,
        token: stash?.claudeAiOauth.accessToken ?? null,
        email: acct.email,
      });
    }
    const counts = new Map<string, number>();
    for (const e of entries) if (e.token) counts.set(e.token, (counts.get(e.token) ?? 0) + 1);
    const resolved: Record<string, string | null> = {};
    for (const [token, n] of counts) {
      if (n >= 2) resolved[token] = await this.resolveEmail(token);
    }
    const { flag } = detectCorruptedStashes(entries, resolved);
    if (flag.length === 0) return;
    const drop = new Set(flag);
    this.registry.accounts = this.registry.accounts.filter((a) => !drop.has(a.slug));
    if (this.registry.activeSlug && drop.has(this.registry.activeSlug)) {
      this.registry.activeSlug = null;
    }
    await writeRegistry(this.registry);
    streamDeck.logger.warn(`accounts: removed cross-wired accounts (re-add via Login): ${flag.join(", ")}`);
  }

  /**
   * Watch the `Claude Code-credentials` keychain entry and adopt whatever
   * lands there once it changes (or appears for the first time). Used by
   * the Login button: spawns a terminal running `claude auth login` and
   * this method picks up the resulting credentials after the user
   * completes the OAuth flow.
   *
   * Captures the current credential blob as a baseline first; the first
   * differing read triggers adoption. Polls every `intervalMs` (default
   * 2000ms) and gives up after `timeoutMs` (default 3 minutes). The
   * optional `displayName` is used as the label if the resulting account
   * is new to the registry.
   *
   * Subsequent calls cancel any prior poll loop.
   */
  pollForNewLogin(
    displayName?: string,
    opts: { timeoutMs?: number; intervalMs?: number } = {},
  ): void {
    const timeoutMs = opts.timeoutMs ?? 180_000;
    const intervalMs = opts.intervalMs ?? 2_000;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    const startedAt = Date.now();
    let baseline: string | null = null;
    void snapshotClaudeCredentials().then((v) => (baseline = v));
    const tick = async (): Promise<void> => {
      const current = await snapshotClaudeCredentials();
      const changed = current != null && current !== baseline;
      if (changed) {
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = undefined;
        const slug = await this.adoptCurrentLogin({ displayName, intent: "explicit" });
        if (slug) this.emit("changed");
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = undefined;
      }
    };
    this.pollTimer = setInterval(() => void tick(), intervalMs);
    this.pollTimer.unref();
  }

  private uniqueSlug(base: string): string {
    if (!this.registry.accounts.some((a) => a.slug === base)) return base;
    for (let i = 2; i < 100; i++) {
      const candidate = `${base}-${i}`;
      if (!this.registry.accounts.some((a) => a.slug === candidate)) return candidate;
    }
    return `${base}-${Date.now()}`;
  }

  private async stashCreds(slug: string, creds: unknown): Promise<void> {
    await writeGenericPassword(
      keychainServiceFor(slug),
      slug,
      JSON.stringify(creds),
    );
  }

  /**
   * Resolve the account email for an access token via `/profile`.
   *
   * Returns the email on success, or `null` when the endpoint *authoritatively*
   * has no email for this token — a 2xx response without one, or a 401/403 that
   * rejects the token outright (retrying changes neither, so both are safe to
   * cache). THROWS on a *transient* failure (network error, 5xx, 429, malformed
   * body) so callers can distinguish "confirmed: not this account" from
   * "couldn't reach the server" and avoid caching the latter.
   */
  private async fetchEmail(token: string): Promise<string | null> {
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch("https://api.anthropic.com/api/oauth/profile", {
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
      });
    } catch (err) {
      throw new Error(`profile lookup failed: ${describeError(err)}`);
    }
    if (res.status === 401 || res.status === 403) return null; // token authoritatively rejected
    if (!res.ok) throw new Error(`profile lookup failed: HTTP ${res.status}`); // 5xx / 429 → transient
    const data = (await res.json()) as { account?: { email?: string } };
    return data.account?.email ?? null;
  }

  /**
   * Swap the active account by writing its stashed credentials back into the
   * keychain entry that Claude Code reads from. Atomic from Claude Code's
   * perspective since `security add-generic-password -U` overwrites in place.
   */
  async swap(slug: string): Promise<void> {
    const acct = this.get(slug);
    if (!acct) throw new Error(`Unknown account: ${slug}`);
    const raw = await readGenericPassword(keychainServiceFor(slug));
    await writeClaudeCredentials(os.userInfo().username, raw);
    this.emailMemo.clear();
    this.registry.activeSlug = slug;
    acct.lastUsedAt = new Date().toISOString();
    await writeRegistry(this.registry);
    this.emit("changed");
    this.emit("swapped", slug);
    notify("siestadeck", `Switched to ${acct.displayName} — restart Claude Code to apply`);
  }

  /**
   * Captures whatever credentials Claude Code currently has and saves them
   * under a new account slug. Called after the user completes an OAuth flow
   * we kicked off, or manually after a `claude auth login` they ran themselves.
   */
  async captureCurrentAs(displayName: string): Promise<Account> {
    const creds = await readClaudeCredentials();
    let resolved: string | null = null;
    try {
      resolved = await this.fetchEmail(creds.claudeAiOauth.accessToken);
    } catch {
      resolved = null; // transient /profile failure — fall back to a placeholder
    }
    const email = resolved ?? `${displayName}@unknown`;
    const slug = this.uniqueSlug(slugify(displayName || email.split("@")[0] || "account"));
    const acct: Account = {
      slug,
      displayName,
      email,
      tier: creds.claudeAiOauth.subscriptionType,
      rateLimitTier: creds.claudeAiOauth.rateLimitTier,
      color: PALETTE[this.registry.accounts.length % PALETTE.length]!,
      addedAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    };
    await this.stashCreds(slug, creds);
    this.emailMemo.clear();
    this.registry.accounts.push(acct);
    this.registry.activeSlug = slug;
    await writeRegistry(this.registry);
    this.emit("changed");
    return acct;
  }

  async remove(slug: string): Promise<void> {
    this.registry.accounts = this.registry.accounts.filter((a) => a.slug !== slug);
    if (this.registry.activeSlug === slug) this.registry.activeSlug = null;
    await writeRegistry(this.registry);
    this.emit("changed");
  }
}

export const accountsService = new AccountsService();
