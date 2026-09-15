import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLAUDE_OAUTH_CLIENT_ID,
  OAUTH_TOKEN_ENDPOINT,
  mapRefreshResponse,
  refreshOAuthToken,
} from "./oauthRefresh.js";

describe("mapRefreshResponse", () => {
  it("uses the response refresh_token when present", () => {
    const out = mapRefreshResponse(
      { access_token: "new-a", refresh_token: "new-r", expires_in: 3600 },
      "old-r",
      1_000_000,
    );
    expect(out).toEqual({
      accessToken: "new-a",
      refreshToken: "new-r",
      expiresAt: 1_000_000 + 3600 * 1000,
    });
  });

  it("falls back to the previous refresh_token when the response omits one", () => {
    const out = mapRefreshResponse(
      { access_token: "new-a", expires_in: 60 },
      "old-r",
      0,
    );
    expect(out.refreshToken).toBe("old-r");
    expect(out.expiresAt).toBe(60_000);
  });
});

describe("refreshOAuthToken", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the refresh_token + client_id to the token endpoint and returns mapped tokens", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: "fresh", refresh_token: "rot", expires_in: 7200 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await refreshOAuthToken("stale-refresh");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(OAUTH_TOKEN_ENDPOINT);
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      grant_type: "refresh_token",
      refresh_token: "stale-refresh",
      client_id: CLAUDE_OAUTH_CLIENT_ID,
    });
    expect(result.accessToken).toBe("fresh");
    expect(result.refreshToken).toBe("rot");
  });

  it("throws when the endpoint returns a non-OK status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 })),
    );
    await expect(refreshOAuthToken("stale")).rejects.toThrow(/HTTP 401/);
  });
});
