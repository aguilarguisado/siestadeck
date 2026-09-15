import streamDeck from "@elgato/streamdeck";

import { ActiveModel } from "./actions/activeModel.js";
import { ExtraUsage } from "./actions/extraUsage.js";
import { LoginLogout } from "./actions/loginLogout.js";
import { QuotaMeter } from "./actions/quotaMeter.js";
import { SwitchAccount } from "./actions/switchAccount.js";

import { init as initRasterizer } from "./render/rasterize.js";
import {
  accountsService,
  activeSessionService,
  notify,
  quotaRegistry,
  setLogger,
} from "@siesta/core";

streamDeck.logger.setLevel("info");

// Bind the core's log sink before anything in @siesta/core runs. The default
// sink is a no-op, so anything logged before this line is silently dropped.
// The scope prefixes core's lines in the rotating logs Elgato's support flow
// collects, so they're distinguishable from the plugin's own.
setLogger(streamDeck.logger.createScope("core"));

process.on("unhandledRejection", (reason) => {
  streamDeck.logger.error(`unhandledRejection: ${reason}`);
});
process.on("uncaughtException", (err) => {
  streamDeck.logger.error(`uncaughtException: ${err}`);
});

streamDeck.actions.registerAction(new QuotaMeter());
streamDeck.actions.registerAction(new ExtraUsage());
streamDeck.actions.registerAction(new ActiveModel());
streamDeck.actions.registerAction(new SwitchAccount());
streamDeck.actions.registerAction(new LoginLogout());

quotaRegistry.on("snapshot", (snap) => {
  const tag = snap.slug ?? "active";
  if (snap.error) streamDeck.logger.warn(`quota[${tag}]: ${snap.error}`);
  else
    streamDeck.logger.info(
      `quota[${tag}]: 5h=${Math.round((snap.fiveHour?.utilization ?? 0) * 100)}% 7d=${Math.round((snap.sevenDay?.utilization ?? 0) * 100)}%`,
    );
});

// The banner lives here, not in accountsService: deciding whether to grab the
// user's attention is a host concern, and the service already emits the event.
// Once a second app watches the same registry, one swap must not produce two
// banners — keeping this host-side is what makes that the host's call.
accountsService.on("swapped", (slug: string) => {
  const acct = accountsService.get(slug);
  if (acct) notify("siestadeck", `Switched to ${acct.displayName} — restart Claude Code to apply`);
});

void initRasterizer().catch((err) => streamDeck.logger.error(`rasterizer init: ${err}`));
void accountsService.start().then(() => {
  quotaRegistry.start();
});

// activeSessionService is lazy: it starts when the first consumer key calls
// `acquire()` in onWillAppear, and stops when the last consumer releases.
// No unconditional start here.

function countConnectedDevices(): number {
  let n = 0;
  for (const d of streamDeck.devices) if (d.isConnected) n++;
  return n;
}

streamDeck.devices.onDeviceDidDisconnect(() => {
  if (countConnectedDevices() > 0) return;
  streamDeck.logger.info("no Stream Deck devices connected — suspending background work");
  quotaRegistry.suspendAuto();
  activeSessionService.releaseAll();
});

// Another siesta app may have added, removed or switched accounts while this
// one was idle, and nothing pushes that across processes. Both moments below are
// the cheapest honest approximation of "we may have missed something": re-read
// the registry, and let the service decide whether anything actually changed.
// It stays silent when the document is unchanged, which matters — quotaRegistry
// answers "changed" with a network refresh.
function syncRegistryFromDisk(reason: string): void {
  void accountsService.reload().then(
    (changed) => {
      if (changed) streamDeck.logger.info(`accounts: registry changed while ${reason}`);
    },
    // Same `while`-clause framing as the success line above: `reason` is an
    // adjectival phrase ("asleep"), so a frame reading "reload after ${reason}
    // failed" parses for neither call site.
    (err) => streamDeck.logger.warn(`accounts: reload failed (${reason}): ${err}`),
  );
}

streamDeck.devices.onDeviceDidConnect(() => {
  // Visible actions re-acquire the local services via their own onWillAppear
  // handlers. We only need to re-arm the quota auto-timers here.
  quotaRegistry.resumeAuto();
  syncRegistryFromDisk("no device was connected");
});

streamDeck.system.onSystemDidWakeUp(() => {
  // Clear the per-account 5s coalesce window so a manual press right after
  // wake isn't suppressed. We do NOT auto-fetch on wake.
  quotaRegistry.markAwake();
  syncRegistryFromDisk("asleep");
});

streamDeck.connect();
