import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMock };
});

const { mkdirMock, readFileMock, writeFileMock } = vi.hoisted(() => ({
  mkdirMock: vi.fn(),
  readFileMock: vi.fn(),
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
      writeFile: writeFileMock,
    },
    mkdir: mkdirMock,
    readFile: readFileMock,
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
});

describe("noopStore", () => {
  it("rejects reads and writes with a platform error", async () => {
    await expect(noopStore.read("s")).rejects.toThrow(/not implemented/);
    await expect(noopStore.write("s", "a", "p")).rejects.toThrow(/not implemented/);
  });
});
