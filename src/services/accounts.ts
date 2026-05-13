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

  async start(): Promise<void> {
    this.registry = await readRegistry();
    await this.reconcilePaletteColors();
    await this.adoptCurrentLoginIfNew();
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
    const creds = await this.loadCreds(slug);
    return creds?.claudeAiOauth?.accessToken ?? null;
  }

  /**
   * Read credentials for `slug` from the freshest available source.
   *
   * Claude Code rotates its OAuth tokens silently (refresh-token rotation is
   * enforced by Anthropic — a successful refresh invalidates the old refresh
   * token). Our per-account stash is only a point-in-time snapshot, so for
   * the **active** slug the live `Claude Code-credentials` entry is the
   * source of truth. For inactive slugs the stash is all we have.
   *
   * As a side effect, when we read fresher tokens out of the live entry
   * than the stash holds, we mirror them back into the stash so a future
   * swap doesn't restore stale credentials.
   */
  private async loadCreds(slug: string): Promise<ClaudeCredentials | null> {
    const isActive = slug === this.registry.activeSlug;
    if (isActive) {
      try {
        const live = await readClaudeCredentials();
        await this.mirrorIntoStashIfNewer(slug, live);
        return live;
      } catch {
        // Fall through to the stash so a transient live-read failure
        // doesn't lock us out of an account we have stashed creds for.
      }
    }
    try {
      const raw = await readGenericPassword(keychainServiceFor(slug));
      return JSON.parse(raw) as ClaudeCredentials;
    } catch {
      return null;
    }
  }

  private async mirrorIntoStashIfNewer(slug: string, live: ClaudeCredentials): Promise<void> {
    try {
      const raw = await readGenericPassword(keychainServiceFor(slug));
      const stashed = JSON.parse(raw) as ClaudeCredentials;
      if (stashed?.claudeAiOauth?.accessToken === live.claudeAiOauth.accessToken) return;
    } catch {
      // No stash yet (or unreadable) — write below.
    }
    try {
      await this.stashCreds(slug, live);
    } catch (err) {
      streamDeck.logger.warn(`accounts[${slug}]: mirror-back failed: ${describeError(err)}`);
    }
  }

  /**
   * Mint a fresh access_token for `slug` by redeeming the freshest available
   * refresh_token against Anthropic's OAuth endpoint, then write the result
   * back to both the per-account stash and (for the active slug) the live
   * `Claude Code-credentials` entry that Claude Code itself reads.
   *
   * Returns true on success, false otherwise. Failure reasons are logged so
   * the 30-minute auth-expired backoff (`UNAUTHORIZED_BACKOFF_MS`) is never
   * a black box.
   *
   * The `__bootstrap__` synthetic slug used by QuotaRegistry has no stash
   * and is short-circuited by the caller.
   */
  async refreshTokenFor(slug: string): Promise<boolean> {
    const isActive = slug === this.registry.activeSlug;
    const source = isActive ? "live keychain" : "stash";
    const creds = await this.loadCreds(slug);
    const oauth = creds?.claudeAiOauth;
    if (!oauth?.refreshToken) {
      streamDeck.logger.warn(`accounts[${slug}]: refresh skipped — no refresh_token in ${source}`);
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
      if (isActive) {
        await writeClaudeCredentials(os.userInfo().username, JSON.stringify(next));
      }
    } catch (err) {
      streamDeck.logger.warn(`accounts[${slug}]: refresh write-back failed: ${describeError(err)}`);
      return false;
    }
    return true;
  }

  /**
   * If Claude Code is already logged in to an account the plugin hasn't seen,
   * adopt it as a saved account on first run so the user doesn't have to
   * re-authenticate just to start using the plugin.
   */
  private async adoptCurrentLoginIfNew(): Promise<void> {
    await this.adoptCurrentLogin();
  }

  /**
   * Read whatever credentials Claude Code currently has stashed and merge
   * them into our registry. If the email matches an existing account we
   * just refresh `lastUsedAt` + re-stash. Otherwise mint a new account
   * (using `displayName` if provided, else the email prefix).
   * Returns the slug that ended up active, or null if no live credentials.
   */
  private async adoptCurrentLogin(displayName?: string): Promise<string | null> {
    let creds;
    try {
      creds = await readClaudeCredentials();
    } catch {
      return null;
    }
    const email = await this.fetchEmail(creds.claudeAiOauth.accessToken);
    if (!email) return null;
    const existing = this.registry.accounts.find((a) => a.email === email);
    if (existing) {
      this.registry.activeSlug = existing.slug;
      existing.lastUsedAt = new Date().toISOString();
      await this.stashCreds(existing.slug, creds);
      await writeRegistry(this.registry);
      return existing.slug;
    }
    const baseName = displayName?.trim() || email.split("@")[0] || "account";
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
    this.registry.activeSlug = slug;
    await this.stashCreds(slug, creds);
    await writeRegistry(this.registry);
    return slug;
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
        const slug = await this.adoptCurrentLogin(displayName);
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

  private async fetchEmail(token: string): Promise<string | null> {
    try {
      const res = await fetch("https://api.anthropic.com/api/oauth/profile", {
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { account?: { email?: string } };
      return data.account?.email ?? null;
    } catch {
      return null;
    }
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
    const email = (await this.fetchEmail(creds.claudeAiOauth.accessToken)) ?? `${displayName}@unknown`;
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
