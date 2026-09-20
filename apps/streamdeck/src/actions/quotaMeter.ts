import {
  action,
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  SingletonAction,
  type TitleParametersDidChangeEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import { toImageUri } from "../render/rasterize.js";
import type { MeterWindow } from "../render/svg.js";
import {
  accountsService,
  openTerminalWithCommand,
  quotaRegistry,
  type QuotaSnapshot,
} from "@siesta/core";
import { drawQuotaMeter, SIESTA_PHRASES } from "./draw/quotaMeter.js";

type QuotaWindow = MeterWindow;

type QuotaMeterSettings = {
  window?: QuotaWindow;
  autoRefresh?: boolean;
  autoRefreshMinutes?: number | string;
};

type Visible = {
  action: KeyAction<QuotaMeterSettings>;
  settings: QuotaMeterSettings;
  tickTimer?: NodeJS.Timeout;
  /** Persiana descent frame index, 0..SIESTA_FRAMES-1; loops back to 0. */
  descentFrame: number;
  /** Index into SIESTA_PHRASES; advances each time the descent loop wraps. */
  phraseIndex: number;
};

// Siesta animation: 20 frames at 250ms = 5s per descent cycle. The phrase
// rotates each time the cycle wraps back to 0, so the user sees all four
// phrases in ~20s of staring at the saturated tile.
const SIESTA_FRAMES = 20;
const SIESTA_FRAME_MS = 250;

/**
 * Cadence for a key that has never been configured. The service floor is 5
 * minutes and two siesta apps may be polling the same rate limit, so this sits
 * at 3× the floor; the idle gate skips ticks entirely once Claude Code has been
 * quiet for 20 minutes.
 */
const DEFAULT_AUTO_REFRESH_MINUTES = 15;

@action({ UUID: "io.github.aguilarguisado.siestadeck.quota-meter" })
export class QuotaMeter extends SingletonAction<QuotaMeterSettings> {
  private visible = new Map<string, Visible>();

  constructor() {
    super();
    quotaRegistry.on("snapshot", (snap: QuotaSnapshot) => {
      if (snap.slug != null) return; // only active-account snapshots
      for (const v of this.visible.values()) void this.draw(v, snap);
    });
  }

  override async onWillAppear(ev: WillAppearEvent<QuotaMeterSettings>): Promise<void> {
    if (!ev.action.isKey()) return;
    const visible: Visible = { action: ev.action, settings: ev.payload.settings, descentFrame: 0, phraseIndex: 0 };
    this.visible.set(ev.action.id, visible);
    await ev.action.setTitle("");
    const cached = quotaRegistry.snapshotFor(null);
    await this.draw(visible, cached ?? null);
    this.applyAutoRefresh(ev.action.id, ev.payload.settings);
  }

  override onWillDisappear(ev: WillDisappearEvent<QuotaMeterSettings>): void {
    const v = this.visible.get(ev.action.id);
    if (v?.tickTimer) clearTimeout(v.tickTimer);
    this.visible.delete(ev.action.id);
    // Off-screen keys don't get a vote on the cadence. The registry stops
    // polling once the last consumer — here or in another action — releases.
    quotaRegistry.releaseAutoRefresh(ev.action.id);
  }

  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<QuotaMeterSettings>,
  ): Promise<void> {
    if (!ev.action.isKey()) return;
    const v = this.visible.get(ev.action.id);
    if (v) v.settings = ev.payload.settings;
    await ev.action.setTitle("");
    const target: Visible = v ?? { action: ev.action, settings: ev.payload.settings, descentFrame: 0, phraseIndex: 0 };
    await this.draw(target, quotaRegistry.snapshotFor(null) ?? null);
    // Only a tracked key votes on the cadence. A settings event for a key that
    // never appeared would leave a request nothing ever releases, since
    // onWillDisappear only fires for keys that did appear.
    if (v) this.applyAutoRefresh(ev.action.id, ev.payload.settings);
  }

  /**
   * Ask the registry to keep the active account current while this key is on
   * screen.
   *
   * **Auto-refresh is on unless the user turned it off.** `undefined` means a
   * key that has never been opened in the Property Inspector, and a gauge that
   * is only correct in the second after you press it is not a gauge. Opting out
   * is a release, not a zero cadence: this key stops asking, and any other key
   * still asking keeps its own polling (`requestAutoRefresh`).
   */
  private applyAutoRefresh(consumerId: string, settings: QuotaMeterSettings): void {
    if (settings.autoRefresh === false) {
      quotaRegistry.releaseAutoRefresh(consumerId);
      return;
    }
    const raw =
      typeof settings.autoRefreshMinutes === "string"
        ? Number(settings.autoRefreshMinutes)
        : settings.autoRefreshMinutes;
    const minutes =
      Number.isFinite(raw) && raw && raw > 0 ? Number(raw) : DEFAULT_AUTO_REFRESH_MINUTES;
    quotaRegistry.requestAutoRefresh(consumerId, minutes * 60_000);
  }

  override async onTitleParametersDidChange(
    ev: TitleParametersDidChangeEvent<QuotaMeterSettings>,
  ): Promise<void> {
    if (!ev.action.isKey()) return;
    if (ev.payload.title) await ev.action.setTitle("");
  }

  override onKeyDown(_ev: KeyDownEvent<QuotaMeterSettings>): void {
    void this.refreshOrLogin();
  }

  /**
   * A press always tries the credentials first, even on a "LOG IN" tile.
   *
   * The auth backoff is a verdict on the token that failed, and by the time the
   * user presses, a working one is often already on file — they just signed in,
   * or Claude Code rotated the live entry. `refresh()` re-reads the credential
   * and drops a backoff that has outlived its failure, so the gauge comes
   * straight back. Only when the refresh *still* reports an auth failure do we
   * spawn the sign-in flow.
   *
   * Reversing this order is what made the tile inescapable: every press reopened
   * a terminal for a login that had already succeeded, and nothing in that path
   * ever re-read the keychain, so the tile asked again 30 minutes later.
   */
  private async refreshOrLogin(): Promise<void> {
    const wasLoggedOut = quotaRegistry.snapshotFor(null)?.cooldownReason === "auth";
    const snap = await quotaRegistry.refresh();
    if (!wasLoggedOut) return;
    if (snap?.cooldownReason !== "auth") return; // fresh creds landed — no sign-in needed
    openTerminalWithCommand("claude auth login");
    accountsService.pollForNewLogin();
  }

  private async draw(visible: Visible, snap: QuotaSnapshot | null): Promise<void> {
    const descentProgress = visible.descentFrame / SIESTA_FRAMES;
    const { svg, cooldownSeconds, resetsInSeconds, isSiesta } = drawQuotaMeter({
      snap,
      window: visible.settings.window,
      phraseIndex: visible.phraseIndex,
      descentProgress,
    });
    await visible.action.setImage(await toImageUri(svg));
    this.scheduleTick(visible, cooldownSeconds, resetsInSeconds, isSiesta);
  }

  /**
   * Schedule the next re-render. While in siesta state, tick at 250ms to
   * advance the persiana descent frame; each completed cycle also advances
   * the phrase. Outside siesta, tick only when something on-tile counts
   * down (cooldown or reset countdown).
   */
  private scheduleTick(visible: Visible, cooldownSeconds: number, resetsInSeconds: number, isSiesta: boolean): void {
    if (visible.tickTimer) {
      clearTimeout(visible.tickTimer);
      visible.tickTimer = undefined;
    }
    let delayMs = 0;
    let onTick: (() => void) | undefined;
    if (isSiesta) {
      delayMs = SIESTA_FRAME_MS;
      onTick = () => {
        const next = visible.descentFrame + 1;
        if (next >= SIESTA_FRAMES) {
          visible.descentFrame = 0;
          visible.phraseIndex = (visible.phraseIndex + 1) % SIESTA_PHRASES.length;
        } else {
          visible.descentFrame = next;
        }
      };
    } else {
      // Reset siesta animation state so the next entry starts fresh.
      visible.descentFrame = 0;
      if (cooldownSeconds > 0) delayMs = 1000;
      else if (resetsInSeconds > 0) delayMs = 30_000;
    }
    if (delayMs === 0) return;
    visible.tickTimer = setTimeout(() => {
      visible.tickTimer = undefined;
      onTick?.();
      void this.draw(visible, quotaRegistry.snapshotFor(null) ?? null);
    }, delayMs);
    visible.tickTimer.unref();
  }
}
