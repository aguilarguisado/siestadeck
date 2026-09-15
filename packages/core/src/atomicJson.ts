import fs from "node:fs/promises";
import path from "node:path";

let writeSeq = 0;

/** Windows errors that mean "the destination was busy just now", not "you may not". */
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Replace `filePath` with `tmp`, retrying while Windows says the destination is busy.
 *
 * On POSIX this is a single `rename(2)` that always succeeds. On Windows it is
 * `MoveFileEx`, which fails with EPERM/EACCES/EBUSY whenever *anything* holds a
 * handle to the destination for the instant of the call — a concurrent writer,
 * an antivirus scanner, or a reader in the other app. The failure is transient
 * by definition, so a short bounded retry converts it into the POSIX behaviour
 * the callers assume. Any other error, and the final attempt, rethrow: a real
 * permissions problem must still surface rather than be swallowed as a retry.
 */
async function renameWithRetry(tmp: string, filePath: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(tmp, filePath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (attempt >= RENAME_ATTEMPTS || !TRANSIENT_RENAME_CODES.has(code)) throw err;
      await sleep(10 * 2 ** (attempt - 1));
    }
  }
}

/**
 * Write a JSON document through a temp file and rename it into place.
 *
 * The rename is what makes this safe: a reader can only ever observe the old
 * document or the new one, never a half-written one — which every reader in this
 * codebase would swallow and report as "empty", silently losing the user's data.
 * The temp name is unique per write (pid + sequence) so two overlapping writes,
 * in this process or another, can't interleave into one file.
 *
 * The atomicity guarantee is not uniform across platforms, and the difference
 * matters here because two siesta apps can write the same file: POSIX
 * `rename(2)` replaces the destination unconditionally, while Windows can refuse
 * a momentarily-busy destination. See `renameWithRetry`.
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
  await renameWithRetry(tmp, filePath);
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
