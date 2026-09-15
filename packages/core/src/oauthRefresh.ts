// OAuth refresh against Anthropic's undocumented Claude Code token endpoint.
//
// The endpoint and client_id below are not officially documented. They are
// the publicly-circulated combo used by the Claude Code CLI. If Anthropic
// rotates either, refresh will fail and quota.ts will fall back to the
// 30-minute auth-expired backoff — the plugin still degrades gracefully.

export const OAUTH_TOKEN_ENDPOINT = "https://console.anthropic.com/v1/oauth/token";
export const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export type OAuthRefreshResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
};

export type RefreshedTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

export function mapRefreshResponse(
  response: OAuthRefreshResponse,
  previousRefreshToken: string,
  now: number = Date.now(),
): RefreshedTokens {
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token ?? previousRefreshToken,
    expiresAt: now + response.expires_in * 1000,
  };
}

export async function refreshOAuthToken(refreshToken: string): Promise<RefreshedTokens> {
  const res = await fetch(OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLAUDE_OAUTH_CLIENT_ID,
    }),
  });
  if (!res.ok) throw new Error(`OAuth refresh failed: HTTP ${res.status}`);
  const json = (await res.json()) as OAuthRefreshResponse;
  return mapRefreshResponse(json, refreshToken);
}
