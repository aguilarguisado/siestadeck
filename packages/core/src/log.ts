/**
 * The core's only concession to its host.
 *
 * Everything else in this package is plain Node, but the services do need to
 * say things out loud — a rejected token refresh, a dropped backoff, a
 * cross-wired account. Each host has its own idea of where that goes: the
 * Stream Deck plugin has `streamDeck.logger` (which writes to the rotating
 * logs the Elgato support flow collects), a desktop app has its own sink, and
 * tests want a spy.
 *
 * So the core logs through this indirection and lets the host bind the sink at
 * startup. The default is a no-op rather than `console`: a core that nobody
 * configured should be silent, not scribble on someone's stdout.
 *
 * The shape is deliberately a structural subset of `streamDeck.logger`, so
 * `setLogger(streamDeck.logger)` type-checks with no adapter.
 */
export type Logger = {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

let sink: Logger = silent;

/** Binds the log sink. Call once, at host startup, before services start. */
export function setLogger(logger: Logger): void {
  sink = logger;
}

/** Restores the no-op sink. Intended for test teardown. */
export function resetLogger(): void {
  sink = silent;
}

/**
 * The current sink. Called per-message rather than destructured at import time
 * so a `setLogger` after module load still takes effect.
 */
export function log(): Logger {
  return sink;
}
