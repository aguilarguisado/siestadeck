/**
 * The menu bar's entire decision surface, as a pure function over plain data.
 *
 * This file is to main.ts what apps/streamdeck/src/actions/draw/*.ts is to the
 * action classes: everything about *which* rows exist, what they say and
 * whether they can be clicked is decided here, so main.ts is left with nothing
 * but the Electron calls that can only run inside a live main process.
 *
 * Nothing in here may import "electron".
 */

import { pickNextSlug, type Account, type QuotaSnapshot, type QuotaWindowSnapshot } from "@siesta/core";

import { formatPercent, formatResetsIn, formatWait, UNKNOWN } from "./format.js";

/** Every clickable row. main.ts dispatches on these and nothing else. */
export type MenuActionId = "swap" | "login" | "refresh" | "quit";

export type MenuRow =
  /** A read-only readout. Rendered disabled — macOS has no other way to say "not a button". */
  | { kind: "info"; label: string }
  | { kind: "action"; id: MenuActionId; label: string; enabled: boolean }
  | { kind: "separator" };

export type MenuModel = {
  /** The text beside the clock. Never empty — the status item would collapse. */
  trayTitle: string;
  rows: MenuRow[];
};

export type MenuInput = {
  /** `quotaRegistry.snapshotFor(null)`; undefined before the first fetch. */
  snapshot: QuotaSnapshot | undefined;
  accounts: readonly Account[];
  activeSlug: string | null;
  /** Passed in rather than read, so the relative times are testable. */
  now: Date;
};

/**
 * "5h · 18% · resets in 1h 15m", dropping the clause it has no data for.
 *
 * The separator is a middle dot rather than the aligned columns the spec
 * sketched: macOS menus render in a proportional font, so padded columns come
 * out ragged no matter how the spaces are counted.
 */
function windowRow(name: string, win: QuotaWindowSnapshot | null | undefined, now: Date): MenuRow {
  const percent = formatPercent(win?.utilization);
  const resets = formatResetsIn(win?.resetsAt, now);
  return { kind: "info", label: resets ? `${name} · ${percent} · resets in ${resets}` : `${name} · ${percent}` };
}

export function buildMenuModel({ snapshot, accounts, activeSlug, now }: MenuInput): MenuModel {
  const cooldownUntil = snapshot?.cooldownUntil ?? null;
  const cooling = cooldownUntil != null && cooldownUntil.getTime() > now.getTime();
  const signedOut = cooling && snapshot?.cooldownReason === "auth";
  const rateLimited = cooling && snapshot?.cooldownReason === "rate";

  const rows: MenuRow[] = [];

  if (signedOut) {
    // Deliberately no countdown, unlike the rate-limit case. The auth backoff is
    // 30 minutes, but it is a verdict on the token that failed, not on us: a
    // refresh that finds a different credential drops it immediately. Showing
    // "retry in 27m" would be telling the user to wait for something they can
    // end right now by signing in.
    rows.push({ kind: "info", label: "Signed out — Claude Code needs to sign in again" });
  } else {
    rows.push(windowRow("5h", snapshot?.fiveHour, now));
    rows.push(windowRow("7d", snapshot?.sevenDay, now));
    // perModel.opus and .sonnet are legacy — the API sends null for both now —
    // so Fable is the only per-model window worth a row. Kept even when absent
    // (an account without a Fable window reads "—") so the menu does not change
    // height between opens.
    rows.push(windowRow("Fable", snapshot?.perModel.fable, now));

    if (rateLimited) {
      const wait = formatWait(cooldownUntil, now);
      rows.push({ kind: "info", label: wait ? `Rate limited — retry in ${wait}` : "Rate limited" });
    }
  }

  rows.push({ kind: "separator" });

  const active = accounts.find((a) => a.slug === activeSlug);
  // null means the click would be a no-op: no accounts, or a single account
  // that is already active. Disabling the row says so before it is pressed.
  const canSwap = pickNextSlug(accounts, activeSlug) !== null;
  rows.push({
    kind: "action",
    id: "swap",
    label: `Account: ${active?.displayName ?? (accounts.length === 0 ? "none" : UNKNOWN)}`,
    enabled: canSwap,
  });
  rows.push({ kind: "action", id: "login", label: "Log in to Claude…", enabled: true });

  rows.push({ kind: "separator" });
  rows.push({ kind: "action", id: "refresh", label: "Refresh", enabled: true });
  rows.push({ kind: "action", id: "quit", label: "Quit Siesta", enabled: true });

  return {
    // While signed out the cached percentage is the last thing we knew, not the
    // current truth, and the menu bar is exactly where a stale number goes
    // unquestioned. "—" is the prompt to open the menu and find out why.
    trayTitle: signedOut ? UNKNOWN : formatPercent(snapshot?.fiveHour?.utilization),
    rows,
  };
}
