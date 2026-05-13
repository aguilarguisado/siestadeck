import fs from "node:fs/promises";

import { projectsDir as PROJECTS_DIR } from "./paths.js";

/**
 * Cheap idle check used to gate optional auto-polling.
 *
 * Returns `true` if the `~/.claude/projects/` directory hasn't been touched
 * within `thresholdMs`. The directory's own mtime updates whenever any
 * subdirectory or session log inside it changes, so this is a single
 * `stat(2)` — no traversal.
 *
 * Returns `false` if the directory is missing or unreadable. We err on the
 * side of "not idle" so we don't accidentally suppress legitimate refreshes
 * on fresh installs.
 */
export async function isClaudeIdle(thresholdMs: number): Promise<boolean> {
  try {
    const stat = await fs.stat(PROJECTS_DIR);
    return Date.now() - stat.mtimeMs > thresholdMs;
  } catch {
    return false;
  }
}
