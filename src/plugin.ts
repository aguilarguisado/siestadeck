import streamDeck from "@elgato/streamdeck";

import { ActiveModel } from "./actions/activeModel.js";
import { Attention } from "./actions/attention.js";
import { ExtraUsage } from "./actions/extraUsage.js";
import { LoginLogout } from "./actions/loginLogout.js";
import { QuotaMeter } from "./actions/quotaMeter.js";
import { SwitchAccount } from "./actions/switchAccount.js";

import { init as initRasterizer } from "./render/rasterize.js";
import { accountsService } from "./services/accounts.js";
import { activeSessionService } from "./services/activeSession.js";
import { attentionService } from "./services/attention.js";
import { quotaRegistry } from "./services/quota.js";

streamDeck.logger.setLevel("info");

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
streamDeck.actions.registerAction(new Attention());

quotaRegistry.on("snapshot", (snap) => {
  const tag = snap.slug ?? "active";
  if (snap.error) streamDeck.logger.warn(`quota[${tag}]: ${snap.error}`);
  else
    streamDeck.logger.info(
      `quota[${tag}]: 5h=${Math.round((snap.fiveHour?.utilization ?? 0) * 100)}% 7d=${Math.round((snap.sevenDay?.utilization ?? 0) * 100)}%`,
    );
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
  attentionService.releaseAll();
});

streamDeck.devices.onDeviceDidConnect(() => {
  // Visible actions re-acquire the local services via their own onWillAppear
  // handlers. We only need to re-arm the quota auto-timers here.
  quotaRegistry.resumeAuto();
});

streamDeck.system.onSystemDidWakeUp(() => {
  // Clear the per-account 5s coalesce window so a manual press right after
  // wake isn't suppressed. We do NOT auto-fetch on wake.
  quotaRegistry.markAwake();
});

streamDeck.connect();
