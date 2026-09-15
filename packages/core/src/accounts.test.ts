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

  it("refuses to point activeSlug at an account removed mid-swap", async () => {
    // Writing the selection anyway would leave the registry naming a row that
    // does not exist: permanently invalid selection, empty tile, no way back
    // without a manual re-add.
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
    await expect(b.swap("bob")).rejects.toThrow(/removed while swapping/);

    expect((await onDisk()).activeSlug).toBe("ada");
    expect(await slugsOnDisk()).toEqual(["ada"]);
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
