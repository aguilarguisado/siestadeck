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

vi.mock("./keychain.js", () => ({
  readClaudeCredentials: vi.fn().mockRejectedValue(new Error("no live creds")),
}));

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
