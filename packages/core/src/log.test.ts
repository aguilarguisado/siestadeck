import { afterEach, describe, expect, it, vi } from "vitest";

import { log, resetLogger, setLogger, type Logger } from "./log.js";

function spyLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

afterEach(() => {
  resetLogger();
});

describe("log", () => {
  it("defaults to a silent sink — an unconfigured core must not scribble on stdout", () => {
    // The Stream Deck SDK speaks over stdio; a stray console.log from an
    // unbound core would corrupt that channel. Silence is the safe default.
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => {
      log().debug("d");
      log().info("i");
      log().warn("w");
      log().error("e");
    }).not.toThrow();
    expect(consoleSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("routes every level to the bound sink", () => {
    const sink = spyLogger();
    setLogger(sink);
    log().debug("d");
    log().info("i");
    log().warn("w");
    log().error("e");
    expect(sink.debug).toHaveBeenCalledWith("d");
    expect(sink.info).toHaveBeenCalledWith("i");
    expect(sink.warn).toHaveBeenCalledWith("w");
    expect(sink.error).toHaveBeenCalledWith("e");
  });

  it("reads the sink per call, so a setLogger after import still takes effect", () => {
    // Services call log() at the point of logging rather than destructuring at
    // module load, which is what lets the host bind a sink after core's modules
    // have already been evaluated.
    const first = spyLogger();
    const second = spyLogger();
    setLogger(first);
    log().warn("to first");
    setLogger(second);
    log().warn("to second");
    expect(first.warn).toHaveBeenCalledTimes(1);
    expect(second.warn).toHaveBeenCalledWith("to second");
  });

  it("resetLogger restores silence, so one test's sink can't leak into the next", () => {
    const sink = spyLogger();
    setLogger(sink);
    resetLogger();
    log().warn("dropped");
    expect(sink.warn).not.toHaveBeenCalled();
  });
});
