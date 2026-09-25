import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Only the consumer lifecycle is pinned here — whether scanning runs, not what
// a scan finds. Every scan starts with a readdir of the projects directory, so
// counting those calls counts scans; the directory need not exist.
vi.mock("./paths.js", () => ({ projectsDir: "/nonexistent/siesta-test/projects" }));

const { ActiveSessionService } = await import("./activeSession.js");

let readdir: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  readdir = vi.spyOn(fs, "readdir");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("consumer lifecycle", () => {
  it("scans at once for the first consumer, then on the timer, and stops with the last", async () => {
    const svc = new ActiveSessionService();
    svc.acquire("key-1");
    svc.acquire("key-2");
    expect(readdir).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(readdir).toHaveBeenCalledTimes(2);

    svc.release("key-1");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(readdir).toHaveBeenCalledTimes(3);

    svc.release("key-2");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(readdir).toHaveBeenCalledTimes(3);
  });

  it("resumes for the keys it already had when the deck comes back without replaying willAppear", async () => {
    const svc = new ActiveSessionService();
    svc.acquire("key-1");
    expect(readdir).toHaveBeenCalledTimes(1);

    // The deck goes away. Stream Deck sends no willDisappear, and on the way
    // back no willAppear: nobody will call acquire() again.
    svc.suspend();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(readdir).toHaveBeenCalledTimes(1);

    svc.resume();
    expect(readdir).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(readdir).toHaveBeenCalledTimes(3);
  });

  it("stays paused for a key that appears while suspended, and does nothing on resume with no consumers", async () => {
    const svc = new ActiveSessionService();
    svc.suspend();
    svc.acquire("key-1");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(readdir).not.toHaveBeenCalled();

    svc.release("key-1");
    svc.resume();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(readdir).not.toHaveBeenCalled();
  });
});
