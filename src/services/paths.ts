import os from "node:os";
import path from "node:path";

import { isWindows } from "./platform.js";

export const claudeHome = path.join(os.homedir(), ".claude");
export const projectsDir = path.join(claudeHome, "projects");
export const claudeSettingsJson = path.join(claudeHome, "settings.json");
export const claudeCredentialsJson = path.join(claudeHome, ".credentials.json");

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
