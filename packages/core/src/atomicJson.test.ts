import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("retries a rename the OS reports as transiently busy, then succeeds", async () => {
    // Windows MoveFileEx fails with EPERM whenever anything holds a handle to
    // the destination for the instant of the call. Simulated here because CI is
    // the only place it reproduces naturally, and only under concurrency.
    const realRename = fs.rename.bind(fs);
    let calls = 0;
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (++calls < 3) throw Object.assign(new Error("busy"), { code: "EPERM" });
      return realRename(from, to);
    });
    const file = path.join(dir, "doc.json");
    await writeJsonAtomic(file, { survived: true });
    expect(calls).toBe(3);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ survived: true });
    spy.mockRestore();
  });

  it("rethrows a non-transient rename error without retrying", async () => {
    // A real permissions or cross-device problem must surface, not be masked as
    // a retry — otherwise a genuine misconfiguration looks like a slow write.
    const spy = vi
      .spyOn(fs, "rename")
      .mockRejectedValue(Object.assign(new Error("nope"), { code: "EXDEV" }));
    await expect(writeJsonAtomic(path.join(dir, "doc.json"), { a: 1 })).rejects.toThrow("nope");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("gives up after a bounded number of retries rather than hanging", async () => {
    const spy = vi
      .spyOn(fs, "rename")
      .mockRejectedValue(Object.assign(new Error("still busy"), { code: "EBUSY" }));
    await expect(writeJsonAtomic(path.join(dir, "doc.json"), { a: 1 })).rejects.toThrow(
      "still busy",
    );
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
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
