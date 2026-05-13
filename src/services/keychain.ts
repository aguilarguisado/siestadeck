import fs from "node:fs/promises";

import { credentialStore } from "./credentialStore.js";
import { claudeCredentialsJson } from "./paths.js";
import { isMac, isWindows } from "./platform.js";

export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

export type ClaudeCredentials = {
  claudeAiOauth: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes: string[];
    subscriptionType: "max" | "pro" | string;
    rateLimitTier: string;
  };
};

export async function readGenericPassword(
  service: string,
  account?: string,
): Promise<string> {
  return credentialStore.read(service, account);
}

export async function writeGenericPassword(
  service: string,
  account: string,
  password: string,
): Promise<void> {
  return credentialStore.write(service, account, password);
}

// On macOS, Claude Code's own credentials live in the keychain entry
// `Claude Code-credentials`. On Windows, Claude Code persists them at
// `~/.claude/.credentials.json` as plaintext JSON (subject to change as
// Anthropic updates the CLI — verify before relying on this for swap).
export async function readClaudeCredentials(): Promise<ClaudeCredentials> {
  let raw: string;
  if (isMac) {
    raw = await credentialStore.read(CLAUDE_KEYCHAIN_SERVICE);
  } else if (isWindows) {
    raw = await fs.readFile(claudeCredentialsJson, "utf8");
  } else {
    throw new Error(`Reading Claude credentials is not supported on ${process.platform}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Could not parse Claude Code credentials JSON");
  }
}

// Snapshot the current Claude credentials in whatever form they're stored.
// Used as a baseline for the post-`claude auth login` change detector.
export async function snapshotClaudeCredentials(): Promise<string | null> {
  try {
    if (isMac) return await credentialStore.read(CLAUDE_KEYCHAIN_SERVICE);
    if (isWindows) return await fs.readFile(claudeCredentialsJson, "utf8");
    return null;
  } catch {
    return null;
  }
}

// Write a fresh credential blob back to wherever Claude Code reads from.
// macOS: keychain entry with `add-generic-password -U` (atomic update).
// Windows: overwrite the JSON file. (`security` writes are in-place; the
// Windows version is best-effort and may race with a running `claude` CLI.)
export async function writeClaudeCredentials(account: string, payload: string): Promise<void> {
  if (isMac) {
    await credentialStore.write(CLAUDE_KEYCHAIN_SERVICE, account, payload);
    return;
  }
  if (isWindows) {
    await fs.writeFile(claudeCredentialsJson, payload, { encoding: "utf8" });
    return;
  }
  throw new Error(`Writing Claude credentials is not supported on ${process.platform}`);
}
