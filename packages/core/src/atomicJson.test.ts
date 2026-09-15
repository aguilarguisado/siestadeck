import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readJsonOr, writeJsonAtomic } from "./atomicJson.js";

// Real filesystem rather than a mock: the whole point of this module is the
// temp-file + rename(2) dance, and a mocked fs would assert the implementation
// back to itself instead of testing that a reader never sees a partial file.
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "siesta-atomic-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("writeJsonAtomic", () => {
  it("round-trips a document", async () => {
    const file = path.join(dir, "doc.json");
    await writeJsonAtomic(file, { a: 1, b: ["x"] });
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ a: 1, b: ["x"] });
  });

  it("creates missing parent directories", async () => {
    const file = path.join(dir, "nested", "deeper", "doc.json");
    await writeJsonAtomic(file, { ok: true });
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ ok: true });
  });

  it("leaves no temp file behind", async () => {
    const file = path.join(dir, "doc.json");
    await writeJsonAtomic(file, { a: 1 });
    expect(await fs.readdir(dir)).toEqual(["doc.json"]);
  });

  it("omits the trailing newline by default — the registry's byte layout", async () => {
    const file = path.join(dir, "registry.json");
    await writeJsonAtomic(file, { accounts: [] });
    expect((await fs.readFile(file, "utf8")).endsWith("}")).toBe(true);
  });

  it("adds a trailing newline on request — settings.json's byte layout", async () => {
    const file = path.join(dir, "settings.json");
    await writeJsonAtomic(file, { model: "opus" }, { trailingNewline: true });
    expect((await fs.readFile(file, "utf8")).endsWith("}\n")).toBe(true);
  });

  it("overwrites an existing document in place", async () => {
    const file = path.join(dir, "doc.json");
    await writeJsonAtomic(file, { v: 1 });
    await writeJsonAtomic(file, { v: 2 });
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ v: 2 });
    expect(await fs.readdir(dir)).toEqual(["doc.json"]);
  });

  it("gives concurrent writes unique temp names, so neither truncates the other", async () => {
    const file = path.join(dir, "doc.json");
    await Promise.all([
      writeJsonAtomic(file, { writer: "a" }),
      writeJsonAtomic(file, { writer: "b" }),
      writeJsonAtomic(file, { writer: "c" }),
    ]);
    // Last rename wins; what must never happen is a torn or absent file.
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    expect(["a", "b", "c"]).toContain(parsed.writer);
    expect(await fs.readdir(dir)).toEqual(["doc.json"]);
  });
});

describe("readJsonOr", () => {
  it("returns the parsed document when the file is good", async () => {
    const file = path.join(dir, "doc.json");
    await fs.writeFile(file, JSON.stringify({ a: 1 }));
    expect(await readJsonOr(file, { a: 0 })).toEqual({ a: 1 });
  });

  it("falls back when the file is missing", async () => {
    expect(await readJsonOr(path.join(dir, "nope.json"), { fallback: true })).toEqual({
      fallback: true,
    });
  });

  it("falls back when the file is unparseable rather than throwing", async () => {
    // A background service must not crash on a corrupt file the user can't see.
    const file = path.join(dir, "corrupt.json");
    await fs.writeFile(file, "{ this is not json");
    expect(await readJsonOr(file, { fallback: true })).toEqual({ fallback: true });
  });

  it("falls back when the file is empty", async () => {
    const file = path.join(dir, "empty.json");
    await fs.writeFile(file, "");
    expect(await readJsonOr(file, { fallback: true })).toEqual({ fallback: true });
  });

  it("falls back when the document is literal null", async () => {
    const file = path.join(dir, "null.json");
    await fs.writeFile(file, "null");
    expect(await readJsonOr(file, { fallback: true })).toEqual({ fallback: true });
  });
});
