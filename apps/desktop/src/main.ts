/**
 * siesta — macOS menu bar app.
 *
 * There is no renderer process. No BrowserWindow, no HTML, no preload, no IPC:
 * the menu is a real NSMenu built by Electron's Menu.buildFromTemplate, and
 * @siesta/core runs directly in this process exactly as it does inside the
 * Stream Deck plugin's host.
 *
 * This file is Electron glue and nothing else. Every decision about what the
 * menu says lives in menuModel.ts, which is pure and tested; if you find
 * yourself writing an `if` about quota here, it belongs over there.
 *
 * The rule inherited from the plugin: this is a stateless renderer. It never
 * fetches, polls or reads a file. It subscribes to service snapshots and
 * rebuilds a menu.
 */

import path from "node:path";

import { app, Menu, nativeImage, powerMonitor, Tray } from "electron";
import type { MenuItemConstructorOptions, NativeImage } from "electron";
import { accountsService, openTerminalWithCommand, pickNextSlug, quotaRegistry, setLogger } from "@siesta/core";
import type { QuotaSnapshot } from "@siesta/core";

import { formatPercent } from "./format.js";
import { buildMenuModel, rowKey, type MenuActionId, type MenuModel } from "./menuModel.js";

const log = {
  info: (m: string) => console.info(`siesta: ${m}`),
  warn: (m: string) => console.warn(`siesta: ${m}`),
  error: (m: string) => console.error(`siesta: ${m}`),
};

// Bind the core's log sink before anything in @siesta/core runs. The default
// sink is a no-op, so anything logged before this line is dropped silently.
// Unlike the Stream Deck host, console is safe here: that host speaks the
// plugin protocol over stdio and a stray write corrupts it. This process owns
// its stdio outright.
setLogger({
  debug: (m) => console.debug(`core: ${m}`),
  info: (m) => console.info(`core: ${m}`),
  warn: (m) => console.warn(`core: ${m}`),
  error: (m) => console.error(`core: ${m}`),
});

process.on("unhandledRejection", (reason) => log.error(`unhandled rejection: ${String(reason)}`));
process.on("uncaughtException", (err) => log.error(`uncaught exception: ${String(err)}`));

/**
 * Conservative on purpose, and the service clamps anything under 5 minutes
 * anyway. Two siesta apps poll independently against one shared rate limit, so
 * a tight cadence here costs roughly double; core's idle gate already skips
 * ticks when Claude Code itself has been quiet for 20 minutes. 15 minutes
 * matches the Stream Deck plugin's default. This is what keeps the *title*
 * current — the menu opening fires its own refresh on top.
 */
const AUTO_REFRESH_MS = 15 * 60_000;

/**
 * There is one status item, so one consumer id is the whole refcount. The
 * registry re-points this at whichever account is active, so nothing here has
 * to re-arm on a swap.
 */
const AUTO_REFRESH_CONSUMER = "menubar";

// Module scope: a Tray that goes out of scope can be garbage collected and take
// the status item with it.
let tray: Tray | undefined;
// Retained while popped up, for the same reason, and so a refresh that lands
// while the menu is open can write into it. Cleared when it closes.
let visibleMenu: Menu | undefined;
let lastTitle = "";

function currentModel(): MenuModel {
  return buildMenuModel({
    snapshot: quotaRegistry.snapshotFor(null),
    accounts: accountsService.list(),
    activeSlug: accountsService.activeSlug,
    now: new Date(),
  });
}

function renderTray(): void {
  const { trayTitle } = currentModel();
  // The same no-op suppression the services use on their own snapshots — and
  // load-bearing here, because "snapshot" fires twice for the active account.
  if (trayTitle === lastTitle) return;
  lastTitle = trayTitle;
  // monospacedDigit stops the status item from shifting width as digits change.
  // There is no colour option: setTitle's options carry only fontType, and a
  // template icon is forced monochrome by macOS, so depletion is not signalled
  // in the menu bar — you get the number, and the colour story lives elsewhere.
  tray?.setTitle(trayTitle, { fontType: "monospacedDigit" });
}

function toTemplate(model: MenuModel): MenuItemConstructorOptions[] {
  return model.rows.map((row) => {
    if (row.kind === "separator") return { type: "separator" };
    // id is what refreshOpenMenu() addresses the row by later.
    // Disabled is macOS's only vocabulary for "a readout, not a button".
    if (row.kind === "info") return { id: rowKey(row), label: row.label, enabled: false };
    return {
      id: rowKey(row),
      label: row.label,
      enabled: row.enabled,
      click: () => void onAction(row.id),
    };
  });
}

/**
 * Write the current numbers into the menu the user is looking at right now.
 *
 * Opening the menu fires a refresh that lands a few hundred milliseconds later,
 * and `MenuItem.label` / `.enabled` are documented as settable after the menu
 * is built — macOS re-lays out an open NSMenu when an item's title changes. So
 * the percentages fill in while the menu is open instead of being right only on
 * the next open.
 *
 * A row whose id is missing from the open menu is skipped: the shape changed
 * under us (a refresh that comes back 401 replaces three window rows with one
 * "Signed out" prompt), and there is nothing to write into. That open menu
 * keeps the numbers it was built with; the next one is built correctly.
 */
function refreshOpenMenu(): void {
  const menu = visibleMenu;
  if (!menu) return;
  for (const row of currentModel().rows) {
    const key = rowKey(row);
    if (key == null || row.kind === "separator") continue;
    const item = menu.getMenuItemById(key);
    if (!item) continue;
    item.label = row.label;
    if (row.kind === "action") item.enabled = row.enabled;
  }
}

async function onAction(id: MenuActionId): Promise<void> {
  switch (id) {
    case "swap":
      return swapToNextAccount();
    case "login":
      return signIn();
    case "quit":
      app.quit();
      return;
  }
}

async function swapToNextAccount(): Promise<void> {
  // Round-robin over every saved account in stable order, the same sequence the
  // Stream Deck's Switch Account key walks. null means the click is a no-op, in
  // which case the row was already disabled — this is the belt to that braces.
  const target = pickNextSlug(accountsService.list(), accountsService.activeSlug);
  if (!target) return;
  try {
    await accountsService.swap(target);
    // No banner. The Stream Deck plugin already raises one on "swapped", and
    // core keeps that decision host-side precisely so one swap does not produce
    // two notifications with both apps running. The user clicked the row, so
    // they know; the row shows the new name the next time it opens.
  } catch (err) {
    // swap() can throw after it has already written credentials and emitted
    // "changed", so this is "the swap may be half-done", not "nothing happened".
    log.error(`swap to ${target} failed: ${String(err)}`);
  }
}

function signIn(): void {
  // Unconditional, like the plugin's dedicated Login action: this row exists to
  // run the OAuth flow, whether that is recovering a lost login or adding a
  // second account. (The quota tile's press has to try refresh() first because
  // there the same button means both things. Here, opening the menu has already
  // fired a refresh, so a stale auth backoff clears on its own.)
  //
  // There is no callback from the flow, so the service polls the keychain every
  // 2s for up to 3 minutes and adopts whatever lands.
  openTerminalWithCommand("claude auth login");
  accountsService.pollForNewLogin();
}

function syncRegistryFromDisk(reason: string): Promise<void> {
  // Another siesta app may have added, removed or swapped accounts while this
  // one was not looking, and nothing pushes that across processes. reload() is
  // pull-only: it re-reads one small JSON document and stays silent unless the
  // fingerprint actually moved. The silence matters — quotaRegistry answers
  // "changed" with a network refresh, so an unconditional emit would spend an
  // API call every time the menu opened.
  return accountsService.reload().then(
    (changed) => {
      if (changed) log.info(`accounts: registry changed while ${reason}`);
    },
    (err) => log.warn(`accounts: reload failed (${reason}): ${String(err)}`),
  );
}

async function openMenu(): Promise<void> {
  await syncRegistryFromDisk("the menu was closed");

  const menu = Menu.buildFromTemplate(toTemplate(currentModel()));
  // Stop addressing a menu that is gone. Without this, a snapshot arriving
  // after the menu closed would write labels into a dead NSMenu.
  menu.once("menu-will-close", () => {
    if (visibleMenu === menu) visibleMenu = undefined;
  });
  visibleMenu = menu;
  tray?.popUpContextMenu(menu);

  // Network, so never awaited before the menu is shown — the click has to feel
  // instant. When it lands, the snapshot handler repaints the title and writes
  // the new numbers into the open menu. The service's own 5s floor coalesces an
  // impatient user opening and closing the menu, which is also why this app has
  // no Refresh row: this *is* the refresh.
  void quotaRegistry.refresh();
}

function trayImage(): NativeImage {
  // getAppPath() is the workspace directory under `electron .` and the resource
  // root inside a bundled .app; __dirname would only ever be right for one.
  const image = nativeImage.createFromPath(path.join(app.getAppPath(), "imgs", "trayTemplate.png"));
  // macOS recolours template images to match the menu bar and inverts them
  // while the menu is open. Without this the glyph stays black on a dark bar.
  image.setTemplateImage(true);
  return image;
}

// Without this the name is taken from package.json and comes out as
// "@siesta/desktop" — in the userData path, and anywhere macOS shows the app to
// the user.
app.setName("siesta");

// No Dock icon and no window — this is a menu bar app. (A packaged build would
// also want LSUIElement in its Info.plist; packaging is not in scope yet.)
app.dock?.hide();

// Never fires, because this app creates no windows. It is here because the
// default handler for it quits the app, and a menu bar app must outlive having
// no windows if one is ever added.
app.on("window-all-closed", () => {});

async function start(): Promise<void> {
  tray = new Tray(trayImage());
  tray.setToolTip("siesta — Claude Code quota");
  tray.setTitle(lastTitle, { fontType: "monospacedDigit" });

  // Deliberately no setContextMenu(): with a context menu set, macOS opens it
  // at the NSStatusItem level and we lose the only hook that runs *before* the
  // menu appears — which is where the cross-process registry re-read has to go.
  tray.on("click", () => void openMenu());
  tray.on("right-click", () => void openMenu());

  powerMonitor.on("resume", () => {
    // Clears the 5s coalesce window, and — because timers do not advance while
    // the machine sleeps — schedules one catch-up fetch a few seconds later if
    // the snapshot is already older than the poll interval. Without it the
    // title would show last night's percentage until 15 minutes of awake time
    // had passed. The delay is core's, so the Wi-Fi has a chance to come back.
    quotaRegistry.markAwake();
    void syncRegistryFromDisk("asleep");
  });

  // Order is load-bearing. quotaRegistry.start() reads accountsService.list(),
  // so the accounts service must have resolved first.
  await accountsService.start();
  quotaRegistry.start();

  // Subscribe only now: quotaRegistry.start() registers its own "changed"
  // listener that re-syncs per-account state and re-points the poll timer, and
  // EventEmitter runs listeners in registration order. Going first would repaint
  // the title from a registry that has not yet heard about the new account.
  accountsService.on("changed", renderTray);
  quotaRegistry.on("snapshot", (snap: QuotaSnapshot) => {
    // "snapshot" is emitted twice for the active account — once tagged with its
    // slug, once aliased to null. Keep the alias and drop the rest: this app
    // only ever shows the active account.
    if (snap.slug != null) return;
    if (snap.error) log.warn(`quota: ${snap.error}`);
    else log.info(`quota: 5h=${formatPercent(snap.fiveHour?.utilization)} 7d=${formatPercent(snap.sevenDay?.utilization)}`);
    renderTray();
    refreshOpenMenu();
  });

  // One request for the whole app, and the registry keeps it pointed at the
  // active account across swaps — hence no re-arming on "changed" here.
  quotaRegistry.requestAutoRefresh(AUTO_REFRESH_CONSUMER, AUTO_REFRESH_MS);
  renderTray();
  log.info(`ready — ${accountsService.list().length} account(s), active ${accountsService.activeSlug ?? "none"}`);
  void quotaRegistry.refresh();
}

// A menu bar app has to be a singleton. A second copy is not a second window
// the user can close — it is a second status item showing the same number with
// no way to tell them apart, a second auto-refresh timer against the same rate
// limit, and a second writer to the account registry. `npm run desktop` twice
// is enough to get there.
//
// The lock is keyed on the app name, so this must come after setName(). macOS
// releases it when the holder exits, including on a crash.
if (app.requestSingleInstanceLock()) {
  void app.whenReady().then(start);
} else {
  log.warn("another instance is already running — exiting");
  app.quit();
}
