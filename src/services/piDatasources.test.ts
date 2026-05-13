import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sendToPropertyInspector, accountsListMock, activeSlugMock } = vi.hoisted(() => ({
  sendToPropertyInspector: vi.fn(async () => undefined),
  accountsListMock: vi.fn(),
  activeSlugMock: vi.fn(),
}));

vi.mock("@elgato/streamdeck", () => ({
  default: {
    ui: {
      sendToPropertyInspector,
    },
  },
}));

vi.mock("./accounts.js", () => ({
  accountsService: {
    list: accountsListMock,
    get activeSlug() {
      return activeSlugMock();
    },
  },
}));

import { handleAccountDatasource } from "./piDatasources.js";

beforeEach(() => {
  sendToPropertyInspector.mockClear();
  accountsListMock.mockReset();
  activeSlugMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeAccount(slug: string, displayName = slug) {
  return {
    slug,
    displayName,
    email: `${slug}@example.com`,
    tier: "max",
    rateLimitTier: "default",
    color: "#000000",
    addedAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("handleAccountDatasource", () => {
  it("returns false for non-datasource events", async () => {
    const handled = await handleAccountDatasource({ payload: { event: "somethingElse" } });
    expect(handled).toBe(false);
    expect(sendToPropertyInspector).not.toHaveBeenCalled();
  });

  it("returns false when payload is null or non-object", async () => {
    expect(await handleAccountDatasource({ payload: null })).toBe(false);
    expect(await handleAccountDatasource({ payload: "string" })).toBe(false);
    expect(sendToPropertyInspector).not.toHaveBeenCalled();
  });

  it("responds to getAccounts with the account list", async () => {
    accountsListMock.mockReturnValue([fakeAccount("personal"), fakeAccount("work")]);
    activeSlugMock.mockReturnValue("personal");

    const handled = await handleAccountDatasource({ payload: { event: "getAccounts" } });

    expect(handled).toBe(true);
    expect(sendToPropertyInspector).toHaveBeenCalledTimes(1);
    const call = sendToPropertyInspector.mock.calls[0]![0] as {
      event: string;
      items: Array<{ value: string; label: string }>;
    };
    expect(call.event).toBe("getAccounts");
    expect(call.items).toEqual([
      { value: "personal", label: "personal ●" },
      { value: "work", label: "work" },
    ]);
  });

  it("prepends a synthetic 'Active account' entry for getAccountsIncludingActive", async () => {
    accountsListMock.mockReturnValue([fakeAccount("only")]);
    activeSlugMock.mockReturnValue(null);

    const handled = await handleAccountDatasource({
      payload: { event: "getAccountsIncludingActive" },
    });

    expect(handled).toBe(true);
    const call = sendToPropertyInspector.mock.calls[0]![0] as {
      event: string;
      items: Array<{ value: string; label: string }>;
    };
    expect(call.event).toBe("getAccountsIncludingActive");
    expect(call.items[0]).toEqual({ value: "", label: "Active account" });
    expect(call.items[1]).toEqual({ value: "only", label: "only" });
  });
});
