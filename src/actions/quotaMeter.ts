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
import { accountsService } from "../services/accounts.js";
import { quotaRegistry, type QuotaSnapshot } from "../services/quota.js";
import { openTerminalWithCommand } from "../services/terminal.js";
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
    this.applyAutoRefresh(ev.payload.settings);
  }

  override onWillDisappear(ev: WillDisappearEvent<QuotaMeterSettings>): void {
    const v = this.visible.get(ev.action.id);
    if (v?.tickTimer) clearTimeout(v.tickTimer);
    this.visible.delete(ev.action.id);
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
    this.applyAutoRefresh(ev.payload.settings);
  }

  private applyAutoRefresh(settings: QuotaMeterSettings): void {
    if (settings.autoRefresh !== true) {
      quotaRegistry.enableAutoRefresh(null, 0);
      return;
    }
    const raw =
      typeof settings.autoRefreshMinutes === "string"
        ? Number(settings.autoRefreshMinutes)
        : settings.autoRefreshMinutes;
    const minutes = Number.isFinite(raw) && raw && raw > 0 ? Number(raw) : 15;
    quotaRegistry.enableAutoRefresh(null, minutes * 60_000);
  }

  override async onTitleParametersDidChange(
    ev: TitleParametersDidChangeEvent<QuotaMeterSettings>,
  ): Promise<void> {
    if (!ev.action.isKey()) return;
    if (ev.payload.title) await ev.action.setTitle("");
  }

  override onKeyDown(_ev: KeyDownEvent<QuotaMeterSettings>): void {
    // When the login is lost the account is parked in a 30-min auth backoff, so
    // a plain refresh is a no-op. Kick off re-login instead — same flow as the
    // Login/Logout action — then poll for the fresh credentials.
    const snap = quotaRegistry.snapshotFor(null);
    if (snap?.cooldownReason === "auth") {
      openTerminalWithCommand("claude auth login");
      accountsService.pollForNewLogin();
      return;
    }
    void quotaRegistry.refresh();
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
