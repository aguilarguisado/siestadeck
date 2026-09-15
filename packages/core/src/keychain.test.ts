import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { credentialStoreMock, readFileMock, writeFileMock } = vi.hoisted(() => ({
  credentialStoreMock: { read: vi.fn(), write: vi.fn() },
  readFileMock: vi.fn(),
  writeFileMock: vi.fn(),
}));

vi.mock("./credentialStore.js", () => ({ credentialStore: credentialStoreMock }));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    default: {
      ...actual.default,
      readFile: readFileMock,
      writeFile: writeFileMock,
    },
    readFile: readFileMock,
    writeFile: writeFileMock,
  };
});

const { platformFlags } = vi.hoisted(() => ({
  platformFlags: { isMac: true, isWindows: false },
}));

vi.mock("./platform.js", () => ({
  get isMac() {
    return platformFlags.isMac;
  },
  get isWindows() {
    return platformFlags.isWindows;
  },
}));

import {
  CLAUDE_KEYCHAIN_SERVICE,
  readClaudeCredentials,
  readGenericPassword,
  snapshotClaudeCredentials,
  writeClaudeCredentials,
  writeGenericPassword,
} from "./keychain.js";

beforeEach(() => {
  credentialStoreMock.read.mockReset();
  credentialStoreMock.write.mockReset();
  readFileMock.mockReset();
  writeFileMock.mockReset();
  platformFlags.isMac = true;
  platformFlags.isWindows = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const SAMPLE = {
  claudeAiOauth: {
    accessToken: "tok",
    refreshToken: "rt",
    expiresAt: 1,
    scopes: ["a"],
    subscriptionType: "max",
    rateLimitTier: "default",
  },
};

describe("readGenericPassword / writeGenericPassword", () => {
  it("delegate to credentialStore.read / write verbatim", async () => {
    credentialStoreMock.read.mockResolvedValue("secret");
    expect(await readGenericPassword("svc", "acc")).toBe("secret");
    expect(credentialStoreMock.read).toHaveBeenCalledWith("svc", "acc");

    await writeGenericPassword("svc", "acc", "secret");
    expect(credentialStoreMock.write).toHaveBeenCalledWith("svc", "acc", "secret");
  });
});

describe("CLAUDE_KEYCHAIN_SERVICE", () => {
  it('is the canonical name "Claude Code-credentials"', () => {
    expect(CLAUDE_KEYCHAIN_SERVICE).toBe("Claude Code-credentials");
  });
});

describe("readClaudeCredentials on macOS", () => {
  it("reads from the credential store and parses JSON", async () => {
    credentialStoreMock.read.mockResolvedValue(JSON.stringify(SAMPLE));
    const result = await readClaudeCredentials();
    expect(result.claudeAiOauth.accessToken).toBe("tok");
    expect(credentialStoreMock.read).toHaveBeenCalledWith("Claude Code-credentials");
  });

  it("throws a friendly error on malformed JSON", async () => {
    credentialStoreMock.read.mockResolvedValue("not-json");
    await expect(readClaudeCredentials()).rejects.toThrow(/Could not parse/);
  });
});

describe("readClaudeCredentials on Windows", () => {
  it("reads the .credentials.json file and parses it", async () => {
    platformFlags.isMac = false;
    platformFlags.isWindows = true;
    readFileMock.mockResolvedValue(JSON.stringify(SAMPLE));
    const result = await readClaudeCredentials();
    expect(result.claudeAiOauth.accessToken).toBe("tok");
    expect(readFileMock).toHaveBeenCalled();
    expect(credentialStoreMock.read).not.toHaveBeenCalled();
  });
});

describe("readClaudeCredentials on other platforms", () => {
  it("rejects with a platform error", async () => {
    platformFlags.isMac = false;
    platformFlags.isWindows = false;
    await expect(readClaudeCredentials()).rejects.toThrow(/not supported/);
  });
});

describe("snapshotClaudeCredentials", () => {
  it("returns the raw value on macOS", async () => {
    credentialStoreMock.read.mockResolvedValue("raw-blob");
    expect(await snapshotClaudeCredentials()).toBe("raw-blob");
  });

  it("returns the raw file contents on Windows", async () => {
    platformFlags.isMac = false;
    platformFlags.isWindows = true;
    readFileMock.mockResolvedValue("file-blob");
    expect(await snapshotClaudeCredentials()).toBe("file-blob");
  });

  it("returns null when the read fails (rather than throwing)", async () => {
    credentialStoreMock.read.mockRejectedValue(new Error("nope"));
    expect(await snapshotClaudeCredentials()).toBeNull();
  });

  it("returns null on other platforms", async () => {
    platformFlags.isMac = false;
    platformFlags.isWindows = false;
    expect(await snapshotClaudeCredentials()).toBeNull();
  });
});

describe("writeClaudeCredentials", () => {
  it("calls credentialStore.write under the Claude Code keychain entry on macOS", async () => {
    await writeClaudeCredentials("alice", "payload");
    expect(credentialStoreMock.write).toHaveBeenCalledWith(
      "Claude Code-credentials",
      "alice",
      "payload",
    );
  });

  it("writes to .credentials.json on Windows", async () => {
    platformFlags.isMac = false;
    platformFlags.isWindows = true;
    await writeClaudeCredentials("alice", "payload");
    expect(writeFileMock).toHaveBeenCalled();
    const [, payload, opts] = writeFileMock.mock.calls[0]!;
    expect(payload).toBe("payload");
    expect(opts).toEqual({ encoding: "utf8" });
  });

  it("rejects on other platforms", async () => {
    platformFlags.isMac = false;
    platformFlags.isWindows = false;
    await expect(writeClaudeCredentials("a", "p")).rejects.toThrow(/not supported/);
  });
});
