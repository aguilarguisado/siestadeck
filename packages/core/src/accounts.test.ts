import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Two AccountsService instances over ONE registry file stand in for the two
// processes this package now has to survive: the Stream Deck plugin and the
// planned tray app. They are separate instances rather than separate processes
// because the hazard is not concurrency primitives — it is that each holds its
// own in-memory copy of a document they both rewrite whole.

const { registryPath } = vi.hoisted(() => ({ registryPath: { current: "" } }));

vi.mock("./paths.js", () => ({
  // Lazy getter, per claudeSettings.test.ts: accounts.ts binds the path at
  // module scope, so only a getter lets each test point at its own temp dir.
  get accountsRegistryJson() {
    return registryPath.current;
  },
}));

const { keychain } = vi.hoisted(() => ({
  keychain: {
    readClaudeCredentials: vi.fn(),
    writeClaudeCredentials: vi.fn(),
    snapshotClaudeCredentials: vi.fn(),
    readGenericPassword: vi.fn(),
    writeGenericPassword: vi.fn(),
  },
}));

vi.mock("./keychain.js", () => keychain);

const { AccountsService } = await import("./accounts.js");
const { writeJsonAtomic, readJsonOr } = await import("./atomicJson.js");

type Row = {
  slug: string;
  displayName: string;
  email: string;
  tier: string;
  rateLimitTier: string;
  color: string;
  addedAt: string;
  lastUsedAt: string;
};
type Doc = { accounts: Row[]; activeSlug: string | null };

function row(slug: string, over: Partial<Row> = {}): Row {
  return {
    slug,
    displayName: slug,
    email: `${slug}@example.com`,
    tier: "max",
    rateLimitTier: "default",
    color: "#D0776C",
    addedAt: `2026-01-0${over.addedAt ?? slug.length}T00:00:00Z`,
    lastUsedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

const creds = (token: string) => ({
  claudeAiOauth: {
    accessToken: token,
    refreshToken: `${token}-refresh`,
    expiresAt: 9_999_999_999,
    subscriptionType: "max",
    rateLimitTier: "default",
  },
});

const onDisk = (): Promise<Doc> => readJsonOr<Doc>(registryPath.current, { accounts: [], activeSlug: null });
const slugsOnDisk = async (): Promise<string[]> => (await onDisk()).accounts.map((a) => a.slug).sort();

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "siesta-accounts-"));
  registryPath.current = path.join(dir, "accounts.json");

  // Default: nobody is logged in and no stash exists. Individual tests opt in.
  // `start()` degrades to a no-op reconcile under these, which is what lets a
  // test seed a document and read it back unchanged.
  keychain.readClaudeCredentials.mockRejectedValue(new Error("no live creds"));
  keychain.readGenericPassword.mockRejectedValue(new Error("no stash"));
  keychain.writeGenericPassword.mockResolvedValue(undefined);
  keychain.writeClaudeCredentials.mockResolvedValue(undefined);
  keychain.snapshotClaudeCredentials.mockResolvedValue(null);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("two processes sharing one registry", () => {
  it("does not delete an account the other process added", async () => {
    // THE regression test. Before mutateRegistry, B held the document it read
    // at start() for its whole lifetime, so B's next write silently reverted
    // every account A had added since — not a narrow race, the steady state.
    await writeJsonAtomic(registryPath.current, {
      accounts: [row("ada"), row("bob")],
      activeSlug: "ada",
    });

    const a = new AccountsService();
    const b = new AccountsService();
    await a.start();
    await b.start();
    expect(await slugsOnDisk()).toEqual(["ada", "bob"]);

    // A adds a third account. B knows nothing about it.
    keychain.readClaudeCredentials.mockResolvedValue(creds("cleo-token"));
    await a.captureCurrentAs("cleo");
    expect(await slugsOnDisk()).toEqual(["ada", "bob", "cleo"]);
    expect(b.list().map((x) => x.slug)).toEqual(["ada", "bob"]); // B is genuinely stale

    // B now writes. With the bug this persists B's stale two-account document.
    keychain.readClaudeCredentials.mockRejectedValue(new Error("no live creds"));
    keychain.readGenericPassword.mockResolvedValue(JSON.stringify(creds("ada-token")));
    await b.swap("ada");

    expect(await slugsOnDisk()).toEqual(["ada", "bob", "cleo"]);
    expect((await onDisk()).activeSlug).toBe("ada");
  });

  it("does not resurrect an account the other process removed", async () => {
    // The mirror direction: a stale writer must not undo a deletion either.
    await writeJsonAtomic(registryPath.current, {
      accounts: [row("ada"), row("bob")],
      activeSlug: "ada",
    });
    const a = new AccountsService();
    const b = new AccountsService();
    await a.start();
    await b.start();

    await a.remove("bob");
    keychain.readGenericPassword.mockResolvedValue(JSON.stringify(creds("ada-token")));
    await b.swap("ada");

    expect(await slugsOnDisk()).toEqual(["ada"]);
  });

  it("clears the selection when the account is removed mid-swap", async () => {
    // Naming the removed row would leave a permanently invalid selection. But
    // leaving the *previous* one in place is wrong too: the credentials for
    // "bob" are already in the keychain by the time this fails, so a registry
    // still saying "ada" describes a live session it does not own, and the tile
    // renders ada's name and quota against bob's account. Null is the honest
    // answer — the next passive adopt sees who Claude Code is really logged in
    // as and re-selects from that.
    await writeJsonAtomic(registryPath.current, {
      accounts: [row("ada"), row("bob")],
      activeSlug: "ada",
    });
    const a = new AccountsService();
    const b = new AccountsService();
    await a.start();
    await b.start();

    await a.remove("bob");
    keychain.readGenericPassword.mockResolvedValue(JSON.stringify(creds("bob-token")));
    const changed = vi.fn();
    b.on("changed", changed);
    await expect(b.swap("bob")).rejects.toThrow(/removed while swapping/);

    expect((await onDisk()).activeSlug).toBeNull();
    expect(await slugsOnDisk()).toEqual(["ada"]);
    // Consumers that missed this would keep rendering the stale selection.
    expect(changed).toHaveBeenCalled();
  });

  it("keeps serving later mutations after one of them throws", async () => {
    // The queue must not be poisoned by a rejected operation — swap() throwing
    // is ordinary, and everything behind it would otherwise reject forever.
    await writeJsonAtomic(registryPath.current, { accounts: [row("ada")], activeSlug: null });
    const svc = new AccountsService();
    await svc.start();

    await expect(svc.swap("ghost")).rejects.toThrow(/Unknown account/);
    keychain.readGenericPassword.mockResolvedValue(JSON.stringify(creds("ada-token")));
    await expect(svc.swap("ada")).resolves.toBeUndefined();
    expect((await onDisk()).activeSlug).toBe("ada");
  });
});

describe("adopting the current login", () => {
  /** Make /profile answer with `email`, optionally doing something first. */
  function profileReturns(email: string, duringCall?: () => Promise<void>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await duringCall?.();
        return { ok: true, status: 200, json: async () => ({ account: { email } }) };
      }),
    );
  }

  it("adopts the live login on a genuinely empty registry", async () => {
    keychain.readClaudeCredentials.mockResolvedValue(creds("ada-token"));
    profileReturns("ada@example.com");

    const svc = new AccountsService();
    await svc.start();

    expect(svc.list().map((a) => a.slug)).toEqual(["ada"]);
    expect((await onDisk()).activeSlug).toBe("ada");
  });

  it("leaves an existing selection alone — the account you picked is sticky", async () => {
    await writeJsonAtomic(registryPath.current, {
      accounts: [row("ada"), row("bob")],
      activeSlug: "bob",
    });
    // Claude Code is logged in as ada, but the user deliberately selected bob.
    keychain.readClaudeCredentials.mockResolvedValue(creds("ada-token"));
    profileReturns("ada@example.com");

    const svc = new AccountsService();
    await svc.start();

    expect((await onDisk()).activeSlug).toBe("bob");
  });

  it("does not steal a selection another process recorded during our startup I/O", async () => {
    // start() spends seconds on keychain reads and /profile calls before the
    // adopt lands. Deciding "is there a valid selection?" against the document
    // held before all that would answer for a registry that no longer exists —
    // so a second app that selected an account in the meantime gets overruled.
    // The write below is injected mid-/profile to land in exactly that window.
    keychain.readClaudeCredentials.mockResolvedValue(creds("ada-token"));
    profileReturns("ada@example.com", async () => {
      await writeJsonAtomic(registryPath.current, {
        accounts: [row("ada"), row("bob")],
        activeSlug: "bob",
      });
    });

    const svc = new AccountsService();
    await svc.start();

    expect((await onDisk()).activeSlug).toBe("bob");
    expect(await slugsOnDisk()).toEqual(["ada", "bob"]);
  });

  it("does not duplicate an account another process added for the same email", async () => {
    keychain.readClaudeCredentials.mockResolvedValue(creds("ada-token"));
    profileReturns("ada@example.com", async () => {
      await writeJsonAtomic(registryPath.current, {
        accounts: [row("ada", { email: "ada@example.com" })],
        activeSlug: "ada",
      });
    });

    const svc = new AccountsService();
    await svc.start();

    expect(await slugsOnDisk()).toEqual(["ada"]);
  });
});

describe("in-process serialisation", () => {
  it("does not lose an update when two mutations overlap on a slow keychain write", async () => {
    // Before the refactor these were safe by accident: both mutations shared
    // one mutable object, so the second observed the first's uncommitted
    // writes. Re-reading from disk hands each its own document and removes
    // that, which is why mutateRegistry serialises. Reachable for real: the
    // Login poll adopting while the user presses Switch Account.
    await writeJsonAtomic(registryPath.current, { accounts: [row("ada")], activeSlug: "ada" });
    const svc = new AccountsService();
    await svc.start();

    // captureCurrentAs stashes inside its mutation closure; make that slow so
    // an unserialised implementation is guaranteed to interleave.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    keychain.writeGenericPassword.mockImplementationOnce(async () => {
      await gate;
    });
    keychain.readClaudeCredentials.mockResolvedValue(creds("cleo-token"));

    const capture = svc.captureCurrentAs("cleo");
    // Start the swap while the capture is parked mid-closure.
    keychain.readGenericPassword.mockResolvedValue(JSON.stringify(creds("ada-token")));
    const swap = svc.swap("ada");
    release();
    await Promise.all([capture, swap]);

    expect(await slugsOnDisk()).toEqual(["ada", "cleo"]);
  });
});

describe("reload", () => {
  it("picks up another process's changes and announces them once", async () => {
    await writeJsonAtomic(registryPath.current, { accounts: [row("ada")], activeSlug: "ada" });
    const svc = new AccountsService();
    await svc.start();

    const changed = vi.fn();
    svc.on("changed", changed);

    await writeJsonAtomic(registryPath.current, {
      accounts: [row("ada"), row("bob")],
      activeSlug: "ada",
    });

    await expect(svc.reload()).resolves.toBe(true);
    expect(svc.list().map((a) => a.slug)).toEqual(["ada", "bob"]);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("stays silent when the document on disk has not changed", async () => {
    // Not cosmetic: QuotaRegistry answers "changed" by clearing auth backoffs
    // and firing a network refresh, so an emit per lid-open costs an API call.
    await writeJsonAtomic(registryPath.current, { accounts: [row("ada")], activeSlug: "ada" });
    const svc = new AccountsService();
    await svc.start();

    const changed = vi.fn();
    svc.on("changed", changed);

    await expect(svc.reload()).resolves.toBe(false);
    await expect(svc.reload()).resolves.toBe(false);
    expect(changed).not.toHaveBeenCalled();
  });

  it("stays silent after this process's own mutation, which it already announced", async () => {
    // The reason reload compares disk against this.registry rather than a
    // stored fingerprint: a stored one would still hold the pre-swap document
    // and make the next reload emit for a change we made ourselves.
    await writeJsonAtomic(registryPath.current, { accounts: [row("ada")], activeSlug: null });
    const svc = new AccountsService();
    await svc.start();
    keychain.readGenericPassword.mockResolvedValue(JSON.stringify(creds("ada-token")));
    await svc.swap("ada");

    const changed = vi.fn();
    svc.on("changed", changed);
    await expect(svc.reload()).resolves.toBe(false);
    expect(changed).not.toHaveBeenCalled();
  });
});

describe("registry hygiene", () => {
  it("hands out copies, so a caller cannot mutate the registry through them", async () => {
    await writeJsonAtomic(registryPath.current, { accounts: [row("ada")], activeSlug: "ada" });
    const svc = new AccountsService();
    await svc.start();

    svc.list()[0]!.displayName = "tampered";
    svc.get("ada")!.email = "tampered@example.com";

    expect(svc.get("ada")?.displayName).toBe("ada");
    expect(svc.get("ada")?.email).toBe("ada@example.com");
  });

  it("does not rewrite the file when a mutation changes nothing", async () => {
    // Every needless write is another window for a sibling app's update to be
    // lost. The passive startup reconcile used to take one on every launch.
    await writeJsonAtomic(registryPath.current, { accounts: [row("ada")], activeSlug: "ada" });
    const svc = new AccountsService();
    await svc.start();

    const before = (await fs.stat(registryPath.current)).mtimeMs;
    await svc.remove("nobody-by-that-name");
    expect((await fs.stat(registryPath.current)).mtimeMs).toBe(before);
  });

  it("repaints palette colors by position on start", async () => {
    await writeJsonAtomic(registryPath.current, {
      accounts: [row("ada", { color: "#000000" }), row("bob", { color: "#000000" })],
      activeSlug: null,
    });
    const svc = new AccountsService();
    await svc.start();

    const colors = (await onDisk()).accounts.map((a) => a.color);
    expect(colors).toEqual(["#D0776C", "#F2C744"]);
  });
});

// ---------------------------------------------------------------------------
// The multi-process tests above cover the mutation path. These cover the rest
// of the class: credential resolution, token refresh, the /profile memo, the
// login poll, and the accessors — all through the public surface, with the
// keychain and the network mocked at the module boundary.
// ---------------------------------------------------------------------------

/**
 * Per-slug stashes. A single mockResolvedValue would hand every account the
 * same blob, which `removeCrossWiredStashes` correctly reads as corruption and
 * then deletes — so the shape of the mock matters to what is being tested.
 */
function stashes(bySlug: Record<string, ReturnType<typeof creds>>): void {
  keychain.readGenericPassword.mockImplementation(async (service: string) => {
    const slug = service.replace(/^siestadeck-token-/, "");
    const found = bySlug[slug];
    if (!found) throw new Error("no stash");
    return JSON.stringify(found);
  });
}

/**
 * One fetch stub for both undocumented endpoints accounts.ts talks to:
 * `/api/oauth/profile` for identity and `/v1/oauth/token` for the refresh.
 * They share the global, so a single-response mock makes one of them lie.
 */
function network(opts: { email?: string | null; profileStatus?: number; refreshOk?: boolean } = {}) {
  const { email = null, profileStatus = 200, refreshOk = true } = opts;
  const mock = vi.fn(async (url: string) => {
    if (String(url).includes("/oauth/profile")) {
      return {
        ok: profileStatus >= 200 && profileStatus < 300,
        status: profileStatus,
        json: async () => (email ? { account: { email } } : {}),
      };
    }
    return {
      ok: refreshOk,
      status: refreshOk ? 200 : 400,
      json: async () => ({ access_token: "minted", refresh_token: "minted-refresh", expires_in: 3600 }),
    };
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** A service over a seeded registry, started and ready. */
async function seeded(doc: Doc): Promise<InstanceType<typeof AccountsService>> {
  await writeJsonAtomic(registryPath.current, doc);
  const svc = new AccountsService();
  await svc.start();
  return svc;
}

describe("accessors return copies", () => {
  it("hands out rows a caller cannot use to mutate the registry", async () => {
    const svc = await seeded({ accounts: [row("ada")], activeSlug: "ada" });

    // The graph behind these is replaced wholesale by every mutation, so a live
    // reference would silently detach at the next await.
    const [listed] = svc.list();
    listed.displayName = "clobbered";
    expect(svc.get("ada")!.displayName).toBe("ada");

    const got = svc.get("ada")!;
    got.email = "clobbered@example.com";
    expect(svc.get("ada")!.email).toBe("ada@example.com");

    expect(svc.get("nobody")).toBeUndefined();
    expect(svc.activeSlug).toBe("ada");
  });

  it("orders accounts oldest-first regardless of the order on disk", async () => {
    const svc = await seeded({
      accounts: [
        row("zoe", { addedAt: "2026-03-01T00:00:00Z" }),
        row("ada", { addedAt: "2026-01-01T00:00:00Z" }),
      ],
      activeSlug: null,
    });
    expect(svc.list().map((a) => a.slug)).toEqual(["ada", "zoe"]);
  });
});

describe("getAccessToken / resolveCreds", () => {
  it("reads the per-account stash for an inactive account", async () => {
    stashes({ ada: creds("ada-stash"), bob: creds("bob-stash") });
    const svc = await seeded({ accounts: [row("ada"), row("bob")], activeSlug: "ada" });
    keychain.readClaudeCredentials.mockClear();

    expect(await svc.getAccessToken("bob")).toBe("bob-stash");
    // Never consults the live entry for an account that isn't selected.
    expect(keychain.readClaudeCredentials).not.toHaveBeenCalled();
  });

  it("returns null when there is no stash at all", async () => {
    const svc = await seeded({ accounts: [row("ada")], activeSlug: null });
    expect(await svc.getAccessToken("ada")).toBeNull();
  });

  it("prefers the live entry for the active account when the token matches the stash", async () => {
    stashes({ ada: creds("same-token") });
    keychain.readClaudeCredentials.mockResolvedValue(creds("same-token"));
    const svc = await seeded({ accounts: [row("ada")], activeSlug: "ada" });
    const fetchMock = network({ email: "ada@example.com" });

    expect(await svc.getAccessToken("ada")).toBe("same-token");
    // Identical tokens are proof enough; no /profile call needed.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("confirms a diverged live entry via /profile and mirrors it back into the stash", async () => {
    stashes({ ada: creds("old-token") });
    keychain.readClaudeCredentials.mockResolvedValue(creds("rotated-token"));
    network({ email: "ada@example.com" });
    const svc = await seeded({ accounts: [row("ada")], activeSlug: "ada" });

    expect(await svc.getAccessToken("ada")).toBe("rotated-token");
    // Mirrored back so a later swap restores the current credentials, not the
    // retired ones.
    expect(keychain.writeGenericPassword).toHaveBeenCalledWith(
      "siestadeck-token-ada",
      "ada",
      JSON.stringify(creds("rotated-token")),
    );
  });

  it("falls back to the stash when /profile says the live entry belongs to someone else", async () => {
    stashes({ ada: creds("ada-stash") });
    keychain.readClaudeCredentials.mockResolvedValue(creds("bob-live"));
    network({ email: "bob@example.com" });
    const svc = await seeded({ accounts: [row("ada")], activeSlug: "ada" });

    // Claude Code is signed in as bob; ada's own stash is the right answer.
    expect(await svc.getAccessToken("ada")).toBe("ada-stash");
  });

  it("memoizes /profile so repeated resolution costs one network call", async () => {
    stashes({ ada: creds("old-token") });
    keychain.readClaudeCredentials.mockResolvedValue(creds("rotated-token"));
    const svc = await seeded({ accounts: [row("ada")], activeSlug: "ada" });
    const fetchMock = network({ email: "ada@example.com" });

    await svc.getAccessToken("ada");
    await svc.getAccessToken("ada");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not memoize a transient /profile failure", async () => {
    stashes({ ada: creds("old-token") });
    keychain.readClaudeCredentials.mockResolvedValue(creds("rotated-token"));
    const svc = await seeded({ accounts: [row("ada")], activeSlug: "ada" });
    // A 5xx is "couldn't reach the server", not "not this account" — caching it
    // would pin the token to unconfirmable for the life of the process.
    const fetchMock = network({ profileStatus: 503 });

    await svc.getAccessToken("ada");
    await svc.getAccessToken("ada");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caches an authoritative 401 from /profile", async () => {
    stashes({ ada: creds("old-token") });
    keychain.readClaudeCredentials.mockResolvedValue(creds("rotated-token"));
    const svc = await seeded({ accounts: [row("ada")], activeSlug: "ada" });
    // A rejected token stays rejected; retrying changes nothing.
    const fetchMock = network({ profileStatus: 401 });

    await svc.getAccessToken("ada");
    await svc.getAccessToken("ada");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("refreshTokenFor", () => {
  it("refuses the synthetic bootstrap slug", async () => {
    const svc = await seeded({ accounts: [], activeSlug: null });
    expect(await svc.refreshTokenFor("__bootstrap__")).toBe(false);
  });

  it("reports false when there is no usable refresh_token", async () => {
    const svc = await seeded({ accounts: [row("ada")], activeSlug: null });
    expect(await svc.refreshTokenFor("ada")).toBe(false);
  });

  it("writes the minted token to the stash only, when the live entry is another account's", async () => {
    stashes({ ada: creds("ada-stash"), bob: creds("bob-stash") });
    const svc = await seeded({ accounts: [row("ada"), row("bob")], activeSlug: "bob" });
    network();
    keychain.writeClaudeCredentials.mockClear();

    expect(await svc.refreshTokenFor("ada")).toBe(true);
    expect(keychain.writeGenericPassword).toHaveBeenCalled();
    // The load-bearing half: clobbering the live entry here would swap the
    // account out from under a running Claude Code.
    expect(keychain.writeClaudeCredentials).not.toHaveBeenCalled();
  });

  it("writes through to the live entry when it belongs to this account", async () => {
    stashes({ ada: creds("ada-tok") });
    keychain.readClaudeCredentials.mockResolvedValue(creds("ada-tok"));
    const svc = await seeded({ accounts: [row("ada")], activeSlug: "ada" });
    network();

    expect(await svc.refreshTokenFor("ada")).toBe(true);
    expect(keychain.writeClaudeCredentials).toHaveBeenCalled();
  });

  it("reports false when Anthropic rejects the refresh", async () => {
    stashes({ ada: creds("ada-tok") });
    const svc = await seeded({ accounts: [row("ada")], activeSlug: null });
    network({ refreshOk: false });

    expect(await svc.refreshTokenFor("ada")).toBe(false);
  });

  it("reports false when the write-back fails", async () => {
    stashes({ ada: creds("ada-tok") });
    const svc = await seeded({ accounts: [row("ada")], activeSlug: null });
    network();
    keychain.writeGenericPassword.mockRejectedValue(new Error("keychain locked"));

    expect(await svc.refreshTokenFor("ada")).toBe(false);
  });
});

describe("remove", () => {
  it("drops the row and clears the selection when it pointed there", async () => {
    const svc = await seeded({ accounts: [row("ada"), row("bob")], activeSlug: "bob" });
    await svc.remove("bob");

    expect(await slugsOnDisk()).toEqual(["ada"]);
    expect((await onDisk()).activeSlug).toBeNull();
  });
});

describe("pollForNewLogin", () => {
  // Real timers with a tiny interval, not fake ones: each tick does real file
  // I/O through writeJsonAtomic, and a fake-timer run hands control back while
  // a tick is still in flight — which then writes into the temp dir afterEach
  // has already removed.

  /** Let the baseline snapshot land before the first tick compares against it. */
  const settleBaseline = () => new Promise((r) => setTimeout(r, 15));

  it("adopts the credentials that land and emits changed", async () => {
    const svc = await seeded({ accounts: [], activeSlug: null });
    const changed = vi.fn();
    svc.on("changed", changed);

    keychain.snapshotClaudeCredentials.mockResolvedValue("before");
    svc.pollForNewLogin("Ada", { intervalMs: 5, timeoutMs: 5_000 });
    await settleBaseline();

    // The OAuth flow completes: a different blob appears.
    keychain.snapshotClaudeCredentials.mockResolvedValue("after");
    keychain.readClaudeCredentials.mockResolvedValue(creds("new-login"));
    network({ email: "ada@example.com" });

    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    expect(await slugsOnDisk()).toEqual(["ada"]);
  });

  it("gives up after the timeout without adopting anything", async () => {
    const svc = await seeded({ accounts: [], activeSlug: null });
    keychain.snapshotClaudeCredentials.mockResolvedValue("unchanged");

    svc.pollForNewLogin(undefined, { intervalMs: 5, timeoutMs: 10 });
    await new Promise((r) => setTimeout(r, 60));

    // The loop stopped on its own, and nothing was adopted.
    expect(keychain.snapshotClaudeCredentials).toHaveBeenCalled();
    expect(await slugsOnDisk()).toEqual([]);
  });

  it("cancels a prior poll loop when called again", async () => {
    const svc = await seeded({ accounts: [], activeSlug: null });
    keychain.snapshotClaudeCredentials.mockResolvedValue("before");

    svc.pollForNewLogin("First", { intervalMs: 5, timeoutMs: 5_000 });
    svc.pollForNewLogin("Second", { intervalMs: 5, timeoutMs: 5_000 });
    await settleBaseline();

    keychain.snapshotClaudeCredentials.mockResolvedValue("after");
    keychain.readClaudeCredentials.mockResolvedValue(creds("new-login"));
    network({ email: "second@example.com" });

    // One adoption, under the second call's display name.
    await vi.waitFor(async () => expect((await onDisk()).accounts).toHaveLength(1));
    expect((await onDisk()).accounts[0].displayName).toBe("Second");
  });
});

describe("adoption on start", () => {
  it("adds the logged-in account on a genuine first run and selects it", async () => {
    keychain.readClaudeCredentials.mockResolvedValue(creds("live-tok"));
    network({ email: "ada@example.com" });
    const svc = await seeded({ accounts: [], activeSlug: null });

    expect(svc.list().map((a) => a.slug)).toEqual(["ada"]);
    expect(svc.activeSlug).toBe("ada");
  });

  it("leaves a deliberate selection alone when Claude Code is on another account", async () => {
    // Sticky selection: Siesta keeps showing the account you picked even when
    // Claude Code is currently logged in to a different one.
    stashes({ ada: creds("ada-stash"), bob: creds("bob-stash") });
    keychain.readClaudeCredentials.mockResolvedValue(creds("ada-live"));
    network({ email: "ada@example.com" });
    const svc = await seeded({ accounts: [row("ada"), row("bob")], activeSlug: "bob" });

    expect(svc.activeSlug).toBe("bob");
  });

  it("re-stashes onto the matching account rather than creating a duplicate", async () => {
    stashes({ ada: creds("ada-stash") });
    keychain.readClaudeCredentials.mockResolvedValue(creds("fresh-ada"));
    network({ email: "ada@example.com" });
    const svc = await seeded({ accounts: [row("ada")], activeSlug: "ada" });

    expect(svc.list()).toHaveLength(1);
    expect(keychain.writeGenericPassword).toHaveBeenCalled();
  });

  it("assigns a unique slug when the display name collides", async () => {
    stashes({ ada: creds("ada-stash") });
    // Same local part, a different account.
    keychain.readClaudeCredentials.mockResolvedValue(creds("other-tok"));
    network({ email: "ada@other.com" });
    const svc = await seeded({ accounts: [row("ada")], activeSlug: "ada" });

    expect(svc.list().map((a) => a.slug).sort()).toEqual(["ada", "ada-2"]);
  });
});

describe("removeCrossWiredStashes pins its verdict to the row it judged", () => {
  it("spares an account another process re-added healthy while /profile was in flight", async () => {
    // Two accounts sharing one access token is unambiguous corruption, and
    // proving who owns it costs a keychain read per account plus a /profile
    // call — seconds. Another process can remove the flagged account and
    // re-add it healthy inside that window. Deleting on the strength of a proof
    // that has since expired is the "accounts vanishing was the bug, not the
    // cleanup" failure the unresolved handling exists to prevent.
    await writeJsonAtomic(registryPath.current, {
      accounts: [row("ada"), row("bob", { addedAt: "2026-01-02T00:00:00Z" })],
      activeSlug: "ada",
    });
    stashes({ ada: creds("shared-tok"), bob: creds("shared-tok") });

    const svc = new AccountsService();

    // While /profile is resolving, the other process deletes bob and the user
    // re-adds it via Login — a fresh row, with a fresh addedAt.
    let rewritten = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/oauth/profile") && !rewritten) {
          rewritten = true;
          await writeJsonAtomic(registryPath.current, {
            accounts: [row("ada"), row("bob", { addedAt: "2026-06-06T00:00:00Z" })],
            activeSlug: "ada",
          });
          await svc.reload(); // the in-memory copy now holds the NEW row
        }
        return { ok: true, status: 200, json: async () => ({ account: { email: "ada@example.com" } }) };
      }),
    );

    await svc.start();

    // bob survives: the verdict was about the row added on 01-02, and that row
    // is gone. Reading addedAt from this.registry here instead would match the
    // re-added row and delete it.
    expect(await slugsOnDisk()).toEqual(["ada", "bob"]);
    expect((await onDisk()).accounts.find((a) => a.slug === "bob")!.addedAt).toBe(
      "2026-06-06T00:00:00Z",
    );
  });
});
