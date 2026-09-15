import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";

import { isClaudeIdle } from "./idle.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isClaudeIdle", () => {
  it("returns true when the projects dir hasn't been touched within the threshold", async () => {
    const now = Date.now();
    vi.spyOn(fs, "stat").mockResolvedValue({ mtimeMs: now - 30 * 60_000 } as Awaited<
      ReturnType<typeof fs.stat>
    >);
    expect(await isClaudeIdle(20 * 60_000)).toBe(true);
  });

  it("returns false when the projects dir has been touched recently", async () => {
    const now = Date.now();
    vi.spyOn(fs, "stat").mockResolvedValue({ mtimeMs: now - 60_000 } as Awaited<
      ReturnType<typeof fs.stat>
    >);
    expect(await isClaudeIdle(20 * 60_000)).toBe(false);
  });

  it("returns false (not idle) when stat throws ENOENT — defensive", async () => {
    vi.spyOn(fs, "stat").mockRejectedValue(Object.assign(new Error("nope"), { code: "ENOENT" }));
    expect(await isClaudeIdle(20 * 60_000)).toBe(false);
  });

  it("treats mtime exactly equal to the threshold as not idle (strict inequality)", async () => {
    const now = Date.now();
    vi.spyOn(fs, "stat").mockResolvedValue({ mtimeMs: now - 20 * 60_000 } as Awaited<
      ReturnType<typeof fs.stat>
    >);
    // Date.now() - stat.mtimeMs === thresholdMs → not strictly greater → returns false
    expect(await isClaudeIdle(20 * 60_000)).toBe(false);
  });
});
