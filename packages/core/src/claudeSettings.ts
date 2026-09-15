import { readJsonOr, writeJsonAtomic } from "./atomicJson.js";
import { claudeSettingsJson as SETTINGS_PATH } from "./paths.js";

export type ClaudeSettings = Record<string, unknown>;

/** Read `~/.claude/settings.json`. Returns `{}` if missing or unparseable. */
export async function readClaudeSettings(): Promise<ClaudeSettings> {
  const parsed = await readJsonOr<unknown>(SETTINGS_PATH, {});
  return parsed && typeof parsed === "object" ? (parsed as ClaudeSettings) : {};
}

/**
 * Read-modify-write `~/.claude/settings.json`.
 *
 * This file belongs to Claude Code, not to us — we only ever touch the keys the
 * mutator names, and we write through a temp+rename so Claude Code can never
 * read a half-written document. `mutate` receives the parsed settings and
 * edits them in place; returning `false` abandons the write entirely.
 */
export async function updateClaudeSettings(
  mutate: (settings: ClaudeSettings) => boolean | void,
): Promise<void> {
  const settings = await readClaudeSettings();
  if (mutate(settings) === false) return;
  await writeJsonAtomic(SETTINGS_PATH, settings, { trailingNewline: true });
}
