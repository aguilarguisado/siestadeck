import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMock };
});

const { mkdirMock, readFileMock, statMock, writeFileMock } = vi.hoisted(() => ({
  mkdirMock: vi.fn(),
  readFileMock: vi.fn(),
  statMock: vi.fn(),
  writeFileMock: vi.fn(),
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    default: {
      ...actual.default,
      mkdir: mkdirMock,
      readFile: readFileMock,
      stat: statMock,
      writeFile: writeFileMock,
    },
    mkdir: mkdirMock,
    readFile: readFileMock,
    stat: statMock,
    writeFile: writeFileMock,
  };
});

import { macStore, noopStore, winStore } from "./credentialStore.js";

class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: vi.fn(), end: vi.fn() };
  kill = vi.fn();
}

function nextSpawn(): FakeProc {
  const proc = new FakeProc();
  spawnMock.mockImplementationOnce(() => proc);
  return proc;
}

// Flush microtasks so any preceding awaits (e.g. fs.readFile) settle before
// we emit events on the spawned process.
function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  spawnMock.mockReset();
  mkdirMock.mockReset().mockResolvedValue(undefined);
  readFileMock.mockReset();
  statMock.mockReset().mockResolvedValue({ mtimeMs: 1_000, size: 10 });
  writeFileMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("macStore (security(1))", () => {
  it("read calls `security find-generic-password -w` and returns trimmed stdout", async () => {
    const proc = nextSpawn();
    const promise = macStore.read("svc", "user");
    proc.stdout.emit("data", Buffer.from("secret-token\n"));
    proc.emit("close", 0);
    expect(await promise).toBe("secret-token");
    expect(spawnMock).toHaveBeenCalledWith(
      "security",
      ["find-generic-password", "-a", "user", "-s", "svc", "-w"],
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }),
    );
  });

  it("read omits the -a flag when no account is provided", async () => {
    const proc = nextSpawn();
    const promise = macStore.read("svc");
    proc.stdout.emit("data", Buffer.from("token"));
    proc.emit("close", 0);
    await promise;
    expect(spawnMock.mock.calls[0]![1]).toEqual([
      "find-generic-password",
      "-s",
      "svc",
      "-w",
    ]);
  });

  it("read rejects with stderr when security exits non-zero", async () => {
    const proc = nextSpawn();
    const promise = macStore.read("svc");
    proc.stderr.emit("data", Buffer.from("not found"));
    proc.emit("close", 44);
    await expect(promise).rejects.toThrow(/security exited 44.*not found/);
  });

  it("write calls add-generic-password with -U for atomic update", async () => {
    const proc = nextSpawn();
    const promise = macStore.write("svc", "user", "newpass");
    proc.emit("close", 0);
    await promise;
    expect(spawnMock).toHaveBeenCalledWith(
      "security",
      ["add-generic-password", "-U", "-s", "svc", "-a", "user", "-w", "newpass"],
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }),
    );
  });

  it("write rejects when security exits non-zero", async () => {
    const proc = nextSpawn();
    const promise = macStore.write("svc", "user", "p");
    proc.stderr.emit("data", Buffer.from("permission denied"));
    proc.emit("close", 1);
    await expect(promise).rejects.toThrow(/security exited 1.*permission denied/);
  });

  it("propagates a spawn error", async () => {
    const proc = nextSpawn();
    const promise = macStore.read("svc");
    proc.emit("error", new Error("ENOENT"));
    await expect(promise).rejects.toThrow("ENOENT");
  });
});

describe("winStore (DPAPI via PowerShell)", () => {
  it("write spawns powershell Protect and persists the encrypted bytes", async () => {
    const proc = nextSpawn();
    const promise = winStore.write("svc", "user", "plaintext-secret");
    await flush();
    proc.stdout.emit("data", Buffer.from("ciphertext"));
    proc.emit("close", 0);
    await promise;
    expect(spawnMock).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining(["-NoProfile", "-NonInteractive", "-Command"]),
      expect.any(Object),
    );
    expect(mkdirMock).toHaveBeenCalled();
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    expect(proc.stdin.write).toHaveBeenCalledWith("plaintext-secret");
    expect(proc.stdin.end).toHaveBeenCalled();
  });

  it("read reads the ciphertext file, calls powershell Unprotect, and caches the result", async () => {
    readFileMock.mockResolvedValue(Buffer.from("ciphertext"));
    const proc = nextSpawn();
    const promise = winStore.read("svc-cache", "user2");
    await flush();
    proc.stdout.emit("data", "decrypted");
    proc.emit("close", 0);
    expect(await promise).toBe("decrypted");

    const cached = await winStore.read("svc-cache", "user2");
    expect(cached).toBe("decrypted");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("read propagates non-zero exit from powershell Unprotect", async () => {
    readFileMock.mockResolvedValue(Buffer.from("garbage"));
    const proc = nextSpawn();
    const promise = winStore.read("svc-broken");
    await flush();
    proc.stderr.emit("data", "Decryption failed");
    proc.emit("close", 1);
    await expect(promise).rejects.toThrow(/Unprotect exited 1.*Decryption failed/);
  });

  it("write propagates non-zero exit from powershell Protect", async () => {
    const proc = nextSpawn();
    const promise = winStore.write("svc-w", "user", "secret");
    await flush();
    proc.stderr.emit("data", "Access denied");
    proc.emit("close", 5);
    await expect(promise).rejects.toThrow(/Protect exited 5.*Access denied/);
  });

  it("write propagates a spawn error", async () => {
    const proc = nextSpawn();
    const promise = winStore.write("svc-err", "user", "secret");
    await flush();
    proc.emit("error", new Error("ENOENT powershell"));
    await expect(promise).rejects.toThrow(/ENOENT powershell/);
  });

  it("re-decrypts when another process has rewritten the blob", async () => {
    // The whole point of validating the cache. Without it this returns the
    // first value forever: the other app has already spent the single-use
    // refresh_token, so a cached stale blob means a 400, a 30-minute auth
    // backoff pinned to a dead token, and a LOG IN tile that never clears even
    // after the user re-logs in.
    readFileMock.mockResolvedValue(Buffer.from("cipher-v1"));
    const first = nextSpawn();
    const p1 = winStore.read("svc-rewritten", "user");
    await flush();
    first.stdout.emit("data", "token-v1");
    first.emit("close", 0);
    expect(await p1).toBe("token-v1");

    // Another process rewrites the file: same path, different bytes.
    readFileMock.mockResolvedValue(Buffer.from("cipher-v2"));
    const second = nextSpawn();
    const p2 = winStore.read("svc-rewritten", "user");
    await flush();
    second.stdout.emit("data", "token-v2");
    second.emit("close", 0);
    expect(await p2).toBe("token-v2");
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("re-decrypts a same-length rewrite landing inside one mtime tick", async () => {
    // An mtime+size stamp cannot see this one: both writes are 8 bytes and
    // filesystem timestamp granularity is coarse enough to put them in the same
    // tick. Hashing the ciphertext does not care about either.
    readFileMock.mockResolvedValue(Buffer.from("cipher-a"));
    const first = nextSpawn();
    const p1 = winStore.read("svc-sametick", "user");
    await flush();
    first.stdout.emit("data", "token-a");
    first.emit("close", 0);
    await p1;

    readFileMock.mockResolvedValue(Buffer.from("cipher-b"));
    const second = nextSpawn();
    const p2 = winStore.read("svc-sametick", "user");
    await flush();
    second.stdout.emit("data", "token-b");
    second.emit("close", 0);
    expect(await p2).toBe("token-b");
  });

  it("serves the cache without a spawn while the blob is untouched", async () => {
    // Re-reading the bytes must not cost us the amortization it protects — the
    // expensive part was always the PowerShell spawn, not the file read.
    readFileMock.mockResolvedValue(Buffer.from("cipher"));
    const proc = nextSpawn();
    const promise = winStore.read("svc-stable", "user");
    await flush();
    proc.stdout.emit("data", "token");
    proc.emit("close", 0);
    await promise;

    expect(await winStore.read("svc-stable", "user")).toBe("token");
    expect(await winStore.read("svc-stable", "user")).toBe("token");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(readFileMock).toHaveBeenCalledTimes(3);
  });

  it("caches what it just wrote, so the writer never pays a spawn to read it back", async () => {
    const proc = nextSpawn();
    const promise = winStore.write("svc-writeback", "user", "fresh-secret");
    await flush();
    proc.stdout.emit("data", Buffer.from("cipher"));
    proc.emit("close", 0);
    await promise;

    // The file holds exactly what we wrote, so the hash matches and the entry
    // stands: one cheap read, no Unprotect spawn.
    readFileMock.mockResolvedValue(Buffer.from("cipher"));
    expect(await winStore.read("svc-writeback", "user")).toBe("fresh-secret");
    expect(spawnMock).toHaveBeenCalledTimes(1); // the Protect only; no Unprotect
  });

  it("re-decrypts when someone overwrote the blob just after our own write", async () => {
    // The write path must not stamp its entry from a second observation of the
    // file: between our writeFile and that observation another app can replace
    // the blob, and pairing our plaintext with their identity yields an entry
    // that matches on every later read and never re-decrypts — the stale
    // credential this whole cache-validation exists to prevent, reintroduced by
    // the code meant to prevent it.
    const proc = nextSpawn();
    const promise = winStore.write("svc-clobbered", "user", "our-secret");
    await flush();
    proc.stdout.emit("data", Buffer.from("our-cipher"));
    proc.emit("close", 0);
    await promise;

    // Their bytes are on disk now, not ours.
    readFileMock.mockResolvedValue(Buffer.from("their-cipher"));
    const reread = nextSpawn();
    const p = winStore.read("svc-clobbered", "user");
    await flush();
    reread.stdout.emit("data", "their-secret");
    reread.emit("close", 0);
    expect(await p).toBe("their-secret");
  });

  it("drops the entry and surfaces the error when the blob is gone", async () => {
    readFileMock.mockResolvedValue(Buffer.from("cipher"));
    const proc = nextSpawn();
    const promise = winStore.read("svc-deleted", "user");
    await flush();
    proc.stdout.emit("data", "token");
    proc.emit("close", 0);
    await promise;

    readFileMock.mockRejectedValue(Object.assign(new Error("nope"), { code: "ENOENT" }));
    await expect(winStore.read("svc-deleted", "user")).rejects.toThrow("nope");

    // And the dead entry is not resurrected if the file comes back byte-identical.
    readFileMock.mockResolvedValue(Buffer.from("cipher"));
    const revived = nextSpawn();
    const p = winStore.read("svc-deleted", "user");
    await flush();
    revived.stdout.emit("data", "token-new");
    revived.emit("close", 0);
    expect(await p).toBe("token-new");
  });
});

describe("noopStore", () => {
  it("rejects reads and writes with a platform error", async () => {
    await expect(noopStore.read("s")).rejects.toThrow(/not implemented/);
    await expect(noopStore.write("s", "a", "p")).rejects.toThrow(/not implemented/);
  });
});
