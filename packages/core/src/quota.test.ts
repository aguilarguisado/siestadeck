import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Pins QuotaRegistry's backoff state machine through the only surface a host
// can see: the snapshots it emits and what refresh() does next. Deliberately
// not reaching into the private per-account state — these tests exist so the
// setBackoff/clearBackoff collapse can be shown to change nothing, and a test
// that asserts on field assignments would just restate the implementation.

// A lazy getter rather than a hoisted instance: vi.hoisted runs before the
// imports, so EventEmitter isn't in scope there yet. quota.ts only touches
// accountsService from inside its methods, so resolving it per access is safe
// and gives each test a fresh emitter with no listeners left over.
const { accountsBox } = vi.hoisted(() => ({
  accountsBox: { current: undefined as unknown as AccountsMock },
}));

vi.mock("./accounts.js", () => ({
  get accountsService() {
    return accountsBox.current;
  },
}));

type AccountsMock = EventEmitter & {
  list: ReturnType<typeof vi.fn>;
  getAccessToken: ReturnType<typeof vi.fn>;
  refreshTokenFor: ReturnType<typeof vi.fn>;
  activeSlug: string | null;
};

function makeAccountsMock(): AccountsMock {
  const emitter = new EventEmitter() as AccountsMock;
  emitter.list = vi.fn(() => [{ slug: "ada", addedAt: "2026-01-01T00:00:00Z" }]);
  emitter.getAccessToken = vi.fn().mockResolvedValue("tok-1");
  emitter.refreshTokenFor = vi.fn().mockResolvedValue(false);
  Object.defineProperty(emitter, "activeSlug", { configurable: true, get: () => "ada" });
  return emitter;
}

const { idleMock } = vi.hoisted(() => ({ idleMock: vi.fn() }));
vi.mock("./idle.js", () => ({ isClaudeIdle: idleMock }));

const { readClaudeCredentialsMock } = vi.hoisted(() => ({
  readClaudeCredentialsMock: vi.fn(),
}));
vi.mock("./keychain.js", () => ({ readClaudeCredentials: readClaudeCredentialsMock }));

const { QuotaRegistry } = await import("./quota.js");

// The endpoint reports utilization as a percentage; asWindow divides by 100.
const USAGE = {
  five_hour: { utilization: 25, resets_at: "2026-09-15T12:00:00Z" },
  seven_day: { utilization: 50, resets_at: "2026-09-20T12:00:00Z" },
};

function okResponse(body: unknown = USAGE) {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body };
}
function errResponse(status: number, headers: Record<string, string> = {}) {
  return { ok: false, status, headers: new Headers(headers), json: async () => ({}) };
}

let fetchMock: ReturnType<typeof vi.fn>;
let accountsMock: AccountsMock;

beforeEach(() => {
  accountsMock = makeAccountsMock();
  accountsBox.current = accountsMock;
  idleMock.mockReset().mockResolvedValue(false);
  // Default: nobody is logged in to Claude Code, so the synthetic bootstrap
  // account has no token to offer. Tests that care override it.
  readClaudeCredentialsMock.mockReset().mockRejectedValue(new Error("no live creds"));
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** The snapshot a refresh publishes, captured off the per-slug event. */
function captureSnapshots(reg: InstanceType<typeof QuotaRegistry>, slug = "ada") {
  const seen: Record<string, unknown>[] = [];
  reg.on(`snapshot:${slug}`, (s: Record<string, unknown>) => seen.push(s));
  return seen;
}

describe("429 → rate backoff", () => {
  it("publishes a rate cooldown and stops hitting the network until it expires", async () => {
    const reg = new QuotaRegistry();
    reg.start();
    const seen = captureSnapshots(reg);

    fetchMock.mockResolvedValueOnce(errResponse(429, { "retry-after": "60" }));
    await reg.refresh("ada");

    const first = seen.at(-1)!;
    expect(first.cooldownReason).toBe("rate");
    expect(first.cooldownUntil).toBeInstanceOf(Date);
    expect(String(first.error)).toMatch(/WAIT/i);

    // A second press inside the window must not spend a request. (Also inside
    // the 5s coalesce, so advance past that to prove it is the backoff talking.)
    vi.setSystemTime(Date.now() + 10_000);
    await reg.refresh("ada");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)!.cooldownReason).toBe("rate");
  });

  it("never lets re-authentication clear a rate backoff", async () => {
    // A 429 is a verdict on the caller, not on the credential — no amount of
    // signing in again earns the quota back.
    const reg = new QuotaRegistry();
    reg.start();

    fetchMock.mockResolvedValueOnce(errResponse(429, { "retry-after": "60" }));
    await reg.refresh("ada");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    accountsMock.getAccessToken.mockResolvedValue("a-brand-new-token");
    vi.setSystemTime(Date.now() + 10_000);
    await reg.refresh("ada");

    expect(fetchMock).toHaveBeenCalledTimes(1); // still parked
  });
});

describe("401 → auth backoff", () => {
  it("parks the account against the failed token when the refresh cannot recover it", async () => {
    const reg = new QuotaRegistry();
    reg.start();
    const seen = captureSnapshots(reg);

    fetchMock.mockResolvedValueOnce(errResponse(401));
    accountsMock.refreshTokenFor.mockResolvedValue(false);
    await reg.refresh("ada");

    const snap = seen.at(-1)!;
    expect(snap.cooldownReason).toBe("auth");
    expect(String(snap.error)).toMatch(/auth expired \(401\)/);
  });

  it("recovers without backing off when the token refresh works", async () => {
    const reg = new QuotaRegistry();
    reg.start();
    const seen = captureSnapshots(reg);

    fetchMock.mockResolvedValueOnce(errResponse(401)).mockResolvedValueOnce(okResponse());
    accountsMock.refreshTokenFor.mockResolvedValue(true);
    accountsMock.getAccessToken
      .mockResolvedValueOnce("tok-1")
      .mockResolvedValue("tok-2-minted");

    await reg.refresh("ada");

    const snap = seen.at(-1)!;
    expect(snap.error).toBeUndefined();
    expect(snap.cooldownUntil).toBeNull();
    expect(snap.fiveHour).toEqual({ utilization: 0.25, resetsAt: new Date("2026-09-15T12:00:00Z") });
  });

  it("drops the auth backoff as soon as a different credential is on file", async () => {
    const reg = new QuotaRegistry();
    reg.start();

    fetchMock.mockResolvedValueOnce(errResponse(401));
    await reg.refresh("ada");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The user signed in again: the account now resolves to a new token, so the
    // backoff describes a credential that is no longer on file.
    accountsMock.getAccessToken.mockResolvedValue("tok-after-relogin");
    fetchMock.mockResolvedValueOnce(okResponse());
    vi.setSystemTime(Date.now() + 10_000);
    const snap = await reg.refresh("ada");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(snap?.error).toBeUndefined();
  });

  it("keeps the backoff when the very same credential is still on file", async () => {
    const reg = new QuotaRegistry();
    reg.start();

    fetchMock.mockResolvedValueOnce(errResponse(401));
    await reg.refresh("ada");

    vi.setSystemTime(Date.now() + 10_000);
    await reg.refresh("ada");
    expect(fetchMock).toHaveBeenCalledTimes(1); // nothing changed — stay parked
  });
});

describe("success clears everything", () => {
  it("lets the next refresh straight through after a recovery", async () => {
    const reg = new QuotaRegistry();
    reg.start();

    fetchMock.mockResolvedValueOnce(errResponse(429, { "retry-after": "1" }));
    await reg.refresh("ada");

    // Past both the 1s retry-after floor... (computeBackoffMs clamps to a 1min
    // minimum, so step past that) and the coalesce window.
    vi.setSystemTime(Date.now() + 61_000);
    fetchMock.mockResolvedValueOnce(okResponse());
    const ok = await reg.refresh("ada");
    expect(ok?.cooldownUntil).toBeNull();
    expect(ok?.cooldownReason).toBeUndefined();

    vi.setSystemTime(Date.now() + 10_000);
    fetchMock.mockResolvedValueOnce(okResponse());
    await reg.refresh("ada");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('accountsService "changed"', () => {
  it("clears an auth backoff and refreshes immediately, defeating the 5s coalesce", async () => {
    // The lastAttemptAt reset is the load-bearing part: without it the
    // follow-up refresh is swallowed by the coalesce window and the tile stays
    // on LOG IN for another five seconds after a successful re-login.
    const reg = new QuotaRegistry();
    reg.start();

    fetchMock.mockResolvedValueOnce(errResponse(401));
    await reg.refresh("ada");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(okResponse());
    accountsMock.emit("changed");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("does not clear a rate backoff", async () => {
    const reg = new QuotaRegistry();
    reg.start();

    fetchMock.mockResolvedValueOnce(errResponse(429, { "retry-after": "60" }));
    await reg.refresh("ada");

    accountsMock.emit("changed");
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('accountsService "swapped"', () => {
  it("refreshes the swapped-to account without waiting out the coalesce window", async () => {
    const reg = new QuotaRegistry();
    reg.start();

    fetchMock.mockResolvedValueOnce(okResponse());
    await reg.refresh("ada");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(okResponse());
    accountsMock.emit("swapped", "ada");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});

describe("non-auth, non-rate errors", () => {
  it("reports the status without arming any cooldown", async () => {
    const reg = new QuotaRegistry();
    reg.start();
    const seen = captureSnapshots(reg);

    fetchMock.mockResolvedValueOnce(errResponse(503));
    await reg.refresh("ada");

    const snap = seen.at(-1)!;
    expect(snap.error).toBe("HTTP 503");
    expect(snap.cooldownUntil).toBeNull();
    expect(snap.cooldownReason).toBeUndefined();

    // A 5xx must not park the account: the next press goes straight out.
    vi.setSystemTime(Date.now() + 10_000);
    fetchMock.mockResolvedValueOnce(okResponse());
    await reg.refresh("ada");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Everything below covers the surface the backoff tests above don't reach:
// lifecycle (start/stop/sync), the auto-refresh timers, and the guard clauses
// that make refresh() a no-op. Same rule as above — assert through the public
// surface, never the private per-account state.
// ---------------------------------------------------------------------------

describe("snapshotFor", () => {
  it("returns undefined until something has been fetched, then the cached snapshot", async () => {
    const reg = new QuotaRegistry();
    reg.start();
    expect(reg.snapshotFor("ada")).toBeUndefined();

    fetchMock.mockResolvedValueOnce(okResponse());
    await reg.refresh("ada");
    expect(reg.snapshotFor("ada")?.slug).toBe("ada");
  });

  it("aliases the active account to slug=null so subscribers can tell the two apart", async () => {
    const reg = new QuotaRegistry();
    reg.start();
    fetchMock.mockResolvedValueOnce(okResponse());
    await reg.refresh("ada");

    // Same underlying data, but the active alias is marked as such.
    expect(reg.snapshotFor("ada")?.slug).toBe("ada");
    expect(reg.snapshotFor(null)?.slug).toBeNull();
  });

  it("returns undefined for an unknown slug, and when no account is active", () => {
    const reg = new QuotaRegistry();
    reg.start();
    expect(reg.snapshotFor("nobody")).toBeUndefined();

    Object.defineProperty(accountsMock, "activeSlug", { configurable: true, get: () => null });
    expect(reg.snapshotFor(null)).toBeUndefined();
  });
});

describe("refresh guards", () => {
  it("does nothing when there is no account to refresh", async () => {
    const reg = new QuotaRegistry();
    reg.start();

    expect(await reg.refresh("nobody")).toBeUndefined();
    Object.defineProperty(accountsMock, "activeSlug", { configurable: true, get: () => null });
    expect(await reg.refresh()).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("coalesces a concurrent refresh into the one already in flight", async () => {
    const reg = new QuotaRegistry();
    reg.start();
    let release!: (v: unknown) => void;
    fetchMock.mockReturnValueOnce(new Promise((r) => (release = r)));

    const first = reg.refresh("ada");
    const second = reg.refresh("ada"); // lands while the first is suspended
    release(okResponse());
    await Promise.all([first, second]);

    // The point: one request, not two.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the active account when no slug is given", async () => {
    const reg = new QuotaRegistry();
    reg.start();
    fetchMock.mockResolvedValueOnce(okResponse());
    expect((await reg.refresh())?.slug).toBe("ada");
  });

  it("publishes the message when the token source itself throws", async () => {
    const reg = new QuotaRegistry();
    reg.start();
    const seen = captureSnapshots(reg);
    accountsMock.getAccessToken.mockResolvedValueOnce(null); // → "No stored token"

    await reg.refresh("ada");

    expect(String(seen.at(-1)!.error)).toMatch(/No stored token/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("sync() against the account list", () => {
  it("drops accounts that are gone and picks up ones that appeared", async () => {
    const reg = new QuotaRegistry();
    reg.start();
    fetchMock.mockResolvedValueOnce(okResponse());
    await reg.refresh("ada");
    expect(reg.snapshotFor("ada")).toBeDefined();

    accountsMock.list.mockReturnValue([{ slug: "bob", addedAt: "2026-01-02T00:00:00Z" }]);
    accountsMock.emit("changed");

    // ada's cached snapshot goes with the account; bob is now refreshable.
    expect(reg.snapshotFor("ada")).toBeUndefined();
    fetchMock.mockResolvedValueOnce(okResponse());
    expect((await reg.refresh("bob"))?.slug).toBe("bob");
  });

  it("falls back to a synthetic account reading the live keychain entry", async () => {
    // Zero saved accounts but Claude Code is logged in: the tile still has
    // something to render rather than going blank.
    accountsMock.list.mockReturnValue([]);
    const reg = new QuotaRegistry();
    reg.start();

    readClaudeCredentialsMock.mockResolvedValue({ claudeAiOauth: { accessToken: "live-tok" } });
    fetchMock.mockResolvedValueOnce(okResponse());
    expect((await reg.refresh("__bootstrap__"))?.slug).toBe("__bootstrap__");
    // It read the live keychain entry, not a per-account stash.
    expect(accountsMock.getAccessToken).not.toHaveBeenCalled();
  });

  it("does not try to re-credential the synthetic account on a 401", async () => {
    accountsMock.list.mockReturnValue([]);
    const reg = new QuotaRegistry();
    reg.start();
    const seen = captureSnapshots(reg, "__bootstrap__");

    readClaudeCredentialsMock.mockResolvedValue({ claudeAiOauth: { accessToken: "live-tok" } });
    fetchMock.mockResolvedValueOnce(errResponse(401));
    await reg.refresh("__bootstrap__");

    // There is no stashed refresh_token for a slug that isn't a real account.
    expect(accountsMock.refreshTokenFor).not.toHaveBeenCalled();
    expect(String(seen.at(-1)!.error)).toMatch(/auth expired/);
  });
});

describe("auto-refresh timers", () => {
  it("clamps the cadence, fires on the interval, and skips the tick while Claude is idle", async () => {
    vi.useFakeTimers();
    const reg = new QuotaRegistry();
    reg.start();

    // Asked for 1s; the floor is 5min, so nothing fires at 1s.
    reg.enableAutoRefresh("ada", 1_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(okResponse());
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Claude Code has gone quiet: the tick still re-arms but spends no request.
    idleMock.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // And it recovers when Claude is active again, proving the re-arm happened.
    idleMock.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("suspends and resumes on the remembered interval", async () => {
    vi.useFakeTimers();
    const reg = new QuotaRegistry();
    reg.start();
    fetchMock.mockResolvedValue(okResponse());
    reg.enableAutoRefresh("ada", 5 * 60_000);

    reg.suspendAuto();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(fetchMock).not.toHaveBeenCalled();

    // resumeAuto takes no interval argument — the state remembers it.
    reg.resumeAuto();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops the timer when passed 0, and ignores accounts that do not exist", async () => {
    vi.useFakeTimers();
    const reg = new QuotaRegistry();
    reg.start();
    fetchMock.mockResolvedValue(okResponse());
    reg.enableAutoRefresh("ada", 5 * 60_000);
    reg.enableAutoRefresh("ada", 0);

    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(fetchMock).not.toHaveBeenCalled();

    // Neither of these should throw.
    reg.enableAutoRefresh("nobody", 5 * 60_000);
    Object.defineProperty(accountsMock, "activeSlug", { configurable: true, get: () => null });
    reg.enableAutoRefresh(null, 5 * 60_000);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stop() clears the timers and forgets every account", async () => {
    vi.useFakeTimers();
    const reg = new QuotaRegistry();
    reg.start();
    fetchMock.mockResolvedValue(okResponse());
    reg.enableAutoRefresh("ada", 5 * 60_000);

    reg.stop();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reg.snapshotFor("ada")).toBeUndefined();
  });
});

describe("markAwake", () => {
  it("clears the coalesce window without fetching anything", async () => {
    const reg = new QuotaRegistry();
    reg.start();
    fetchMock.mockResolvedValue(okResponse());
    await reg.refresh("ada");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Inside the 5s floor: suppressed.
    await reg.refresh("ada");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    reg.markAwake();
    expect(fetchMock).toHaveBeenCalledTimes(1); // markAwake itself fetches nothing

    await reg.refresh("ada");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
