import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { settingsPath } = vi.hoisted(() => ({
  settingsPath: {
    // Filled in by beforeEach; the mock below reads it lazily so each test gets
    // its own temp file instead of writing to the developer's real ~/.claude.
    current: "",
  },
}));

vi.mock("./paths.js", () => ({
  get claudeSettingsJson() {
    return settingsPath.current;
  },
}));

const { readClaudeSettings, updateClaudeSettings } = await import("./claudeSettings.js");

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "siesta-settings-"));
  settingsPath.current = path.join(dir, "settings.json");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("readClaudeSettings", () => {
  it("returns the parsed settings", async () => {
    await fs.writeFile(settingsPath.current, JSON.stringify({ model: "opus" }));
    expect(await readClaudeSettings()).toEqual({ model: "opus" });
  });

  it("returns {} when the file is missing", async () => {
    expect(await readClaudeSettings()).toEqual({});
  });

  it("returns {} when the file is corrupt", async () => {
    await fs.writeFile(settingsPath.current, "not json at all");
    expect(await readClaudeSettings()).toEqual({});
  });

  it("returns {} when the document is a non-object — a JSON array is not settings", async () => {
    await fs.writeFile(settingsPath.current, "42");
    expect(await readClaudeSettings()).toEqual({});
  });
});

describe("updateClaudeSettings", () => {
  it("preserves every key the mutator didn't touch", async () => {
    // settings.json belongs to Claude Code. Clobbering keys we never read is
    // exactly the bug this module exists to prevent.
    await fs.writeFile(
      settingsPath.current,
      JSON.stringify({ model: "sonnet", theme: "dark", nested: { a: 1 } }),
    );
    await updateClaudeSettings((s) => {
      s.model = "opus";
    });
    expect(JSON.parse(await fs.readFile(settingsPath.current, "utf8"))).toEqual({
      model: "opus",
      theme: "dark",
      nested: { a: 1 },
    });
  });

  it("writes a trailing newline, matching the file's existing layout", async () => {
    await updateClaudeSettings((s) => {
      s.model = "haiku";
    });
    expect((await fs.readFile(settingsPath.current, "utf8")).endsWith("}\n")).toBe(true);
  });

  it("creates the file when it doesn't exist yet", async () => {
    await updateClaudeSettings((s) => {
      s.model = "opus";
    });
    expect(JSON.parse(await fs.readFile(settingsPath.current, "utf8"))).toEqual({ model: "opus" });
  });

  it("abandons the write when the mutator returns false", async () => {
    await fs.writeFile(settingsPath.current, JSON.stringify({ model: "sonnet" }));
    await updateClaudeSettings((s) => {
      s.model = "opus";
      return false;
    });
    expect(JSON.parse(await fs.readFile(settingsPath.current, "utf8"))).toEqual({
      model: "sonnet",
    });
  });

  it("writes when the mutator returns undefined — only an explicit false aborts", async () => {
    await updateClaudeSettings((s) => {
      s.model = "opus";
    });
    expect(await readClaudeSettings()).toEqual({ model: "opus" });
  });

  it("leaves no temp file behind", async () => {
    await updateClaudeSettings((s) => {
      s.model = "opus";
    });
    expect(await fs.readdir(dir)).toEqual(["settings.json"]);
  });
});
