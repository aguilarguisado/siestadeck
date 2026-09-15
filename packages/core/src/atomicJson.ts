import fs from "node:fs/promises";
import path from "node:path";

let writeSeq = 0;

/**
 * Write a JSON document through a temp file and rename it into place.
 *
 * `rename(2)` is atomic, so an interrupted write can never leave a truncated
 * document behind — which every reader in this codebase would swallow and
 * report as "empty", silently losing the user's data. The temp name is unique
 * per write (pid + sequence) so two overlapping writes, in this process or
 * another, can't interleave into one file.
 *
 * `trailingNewline` exists so callers can match the byte layout a file already
 * has on disk: the accounts registry has never had one, `~/.claude/settings.json`
 * always has. Neither matters to `JSON.parse`; it matters to diffs and to not
 * churning a file another program owns.
 */
export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  opts: { trailingNewline?: boolean } = {},
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${++writeSeq}.tmp`;
  const body = JSON.stringify(value, null, 2) + (opts.trailingNewline ? "\n" : "");
  await fs.writeFile(tmp, body);
  await fs.rename(tmp, filePath);
}

/**
 * Read a JSON document, falling back to `fallback` if it is missing, empty, or
 * unparseable. Deliberately swallowing: every caller here treats "no file yet"
 * and "corrupt file" the same way — start from a known-good default rather than
 * crash a background service on a file the user can't see.
 */
export async function readJsonOr<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}
