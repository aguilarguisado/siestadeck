import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMock };
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

class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  unref = vi.fn(() => this);
}

import { notify, openTerminalWithCommand } from "./terminal.js";

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => new FakeProc());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("openTerminalWithCommand on macOS", () => {
  beforeEach(() => {
    platformFlags.isMac = true;
    platformFlags.isWindows = false;
  });

  it("spawns osascript with the AppleScript that opens Terminal.app", () => {
    openTerminalWithCommand("claude auth login");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0]!;
    expect(cmd).toBe("osascript");
    expect(args[0]).toBe("-e");
    expect(args[1]).toContain('tell application "Terminal" to do script');
    expect(args[1]).toContain("claude auth login");
    expect(opts).toMatchObject({ detached: true });
  });

  it("escapes double quotes in the command", () => {
    openTerminalWithCommand('echo "hi"');
    expect(spawnMock.mock.calls[0]![1][1]).toContain('echo \\"hi\\"');
  });

  it("prefixes a cd when cwd is given", () => {
    openTerminalWithCommand("ls", { cwd: "/tmp/foo" });
    expect(spawnMock.mock.calls[0]![1][1]).toContain('cd "/tmp/foo" && ls');
  });
});

describe("openTerminalWithCommand on Windows", () => {
  beforeEach(() => {
    platformFlags.isMac = false;
    platformFlags.isWindows = true;
  });

  it("spawns cmd.exe with /c start so the window stays open", () => {
    openTerminalWithCommand("claude auth login");
    const [cmd, args] = spawnMock.mock.calls[0]!;
    expect(cmd).toBe("cmd.exe");
    expect(args).toEqual(["/c", "start", "", "cmd.exe", "/k", "claude auth login"]);
  });

  it("includes a cd /d prefix when cwd is set", () => {
    openTerminalWithCommand("claude auth login", { cwd: "C:\\Users\\me" });
    const args = spawnMock.mock.calls[0]![1];
    expect(args[args.length - 1]).toBe('cd /d "C:\\Users\\me" && claude auth login');
  });
});

describe("openTerminalWithCommand on other platforms", () => {
  it("is a no-op", () => {
    platformFlags.isMac = false;
    platformFlags.isWindows = false;
    openTerminalWithCommand("anything");
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("notify", () => {
  it("fires osascript display-notification on macOS", () => {
    platformFlags.isMac = true;
    platformFlags.isWindows = false;
    notify("Hello", "World");
    expect(spawnMock).toHaveBeenCalledWith(
      "osascript",
      expect.arrayContaining(["-e"]),
      expect.objectContaining({ detached: true }),
    );
    expect(spawnMock.mock.calls[0]![1][1]).toContain('display notification "World" with title "Hello"');
  });

  it("escapes quotes in title and body", () => {
    platformFlags.isMac = true;
    platformFlags.isWindows = false;
    notify('Title "x"', 'Body "y"');
    expect(spawnMock.mock.calls[0]![1][1]).toContain('Title \\"x\\"');
    expect(spawnMock.mock.calls[0]![1][1]).toContain('Body \\"y\\"');
  });

  it("is a no-op on Windows (no native toast in v0.1)", () => {
    platformFlags.isMac = false;
    platformFlags.isWindows = true;
    notify("Hello", "World");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("is a no-op on other platforms", () => {
    platformFlags.isMac = false;
    platformFlags.isWindows = false;
    notify("Hello", "World");
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
