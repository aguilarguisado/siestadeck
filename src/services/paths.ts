import os from "node:os";
import path from "node:path";

import { isWindows } from "./platform.js";

export const claudeHome = path.join(os.homedir(), ".claude");
export const projectsDir = path.join(claudeHome, "projects");
export const claudeSettingsJson = path.join(claudeHome, "settings.json");
export const claudeCredentialsJson = path.join(claudeHome, ".credentials.json");

// Attention action: Claude Code hook commands append their stdin payload here.
// The hook command string (attentionPolicy.ts) expands $HOME / %USERPROFILE%
// itself, so it resolves to the same location as os.homedir() by construction.
export const siestadeckClaudeDir = path.join(claudeHome, "siestadeck");
export const attentionEventsJsonl = path.join(siestadeckClaudeDir, "attention.jsonl");
export const attentionEventsRotated = attentionEventsJsonl + ".old";

function defaultRegistryDir(): string {
  if (isWindows) {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "siestadeck");
  }
  return path.join(os.homedir(), ".config", "siestadeck");
}

export const accountsRegistryDir = defaultRegistryDir();
export const accountsRegistryJson = path.join(accountsRegistryDir, "accounts.json");
export const winCredsDir = path.join(accountsRegistryDir, "creds");
