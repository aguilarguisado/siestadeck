import {
  action,
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import { toImageUri } from "../render/rasterize.js";
import { attentionService, type AttentionSnapshot } from "../services/attention.js";
import {
  type AttentionKeySettings,
  type AttentionState,
  enabledFromSettings,
} from "../services/attentionPolicy.js";
import { drawAttention } from "./draw/attention.js";

type Visible = {
  action: KeyAction<AttentionKeySettings>;
  settings: AttentionKeySettings;
  flashTimer?: NodeJS.Timeout;
  /** 0 | 1 — which blocked flash frame is showing. */
  flashFrame: number;
};

const FLASH_MS = 500;

@action({ UUID: "io.github.aguilarguisado.siestadeck.attention" })
export class Attention extends SingletonAction<AttentionKeySettings> {
  private visible = new Map<string, Visible>();

  constructor() {
    super();
    attentionService.on("snapshot", (snap: AttentionSnapshot) => {
      for (const v of this.visible.values()) void this.draw(v, snap);
    });
  }

  override async onWillAppear(ev: WillAppearEvent<AttentionKeySettings>): Promise<void> {
    if (!ev.action.isKey()) return;
    const visible: Visible = { action: ev.action, settings: ev.payload.settings, flashFrame: 0 };
    this.visible.set(ev.action.id, visible);
    attentionService.acquire(ev.action.id);
    await ev.action.setTitle("");
    await this.draw(visible, attentionService.snapshot ?? null);
  }

  override onWillDisappear(ev: WillDisappearEvent<AttentionKeySettings>): void {
    const v = this.visible.get(ev.action.id);
    if (v?.flashTimer) clearTimeout(v.flashTimer);
    this.visible.delete(ev.action.id);
    attentionService.release(ev.action.id);
  }

  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<AttentionKeySettings>,
  ): Promise<void> {
    if (!ev.action.isKey()) return;
    const v = this.visible.get(ev.action.id);
    if (v) v.settings = ev.payload.settings;
    const target: Visible = v ?? { action: ev.action, settings: ev.payload.settings, flashFrame: 0 };
    await this.draw(target, attentionService.snapshot ?? null);
  }

  /**
   * SETUP state → merge the hooks into ~/.claude/settings.json.
   * Otherwise → acknowledge the alarm states this key is configured to show.
   */
  override async onKeyDown(ev: KeyDownEvent<AttentionKeySettings>): Promise<void> {
    if (!ev.action.isKey()) return;
    const snap = attentionService.snapshot;
    if (!snap || !snap.hooksInstalled) {
      try {
        await attentionService.installHooks();
        await ev.action.showOk();
      } catch {
        await ev.action.showAlert();
      }
      return;
    }
    const enabled = enabledFromSettings(
      this.visible.get(ev.action.id)?.settings ?? ev.payload.settings,
    );
    const states = (Object.keys(enabled) as AttentionState[]).filter((s) => enabled[s]);
    attentionService.acknowledge(states);
  }

  private async draw(v: Visible, snap: AttentionSnapshot | null): Promise<void> {
    const { svg, flashing } = drawAttention({ snap, settings: v.settings, flashFrame: v.flashFrame });
    await v.action.setImage(await toImageUri(svg));
    this.scheduleFlash(v, flashing);
  }

  private scheduleFlash(v: Visible, flashing: boolean): void {
    if (v.flashTimer) {
      clearTimeout(v.flashTimer);
      v.flashTimer = undefined;
    }
    if (!flashing || !this.visible.has(v.action.id)) {
      v.flashFrame = 0;
      return;
    }
    v.flashTimer = setTimeout(() => {
      v.flashTimer = undefined;
      v.flashFrame = 1 - v.flashFrame;
      void this.draw(v, attentionService.snapshot ?? null);
    }, FLASH_MS);
    v.flashTimer.unref();
  }
}
