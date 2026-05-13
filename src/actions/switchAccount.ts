import {
  action,
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  type SendToPluginEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import { toImageUri } from "../render/rasterize.js";
import { accountsService } from "../services/accounts.js";
import { handleAccountDatasource } from "../services/piDatasources.js";
import { drawSwitchAccount } from "./draw/switchAccount.js";

type Settings = { mode?: "next" | "specific"; targetSlug?: string };

type Visible = { action: KeyAction<Settings>; settings: Settings };

@action({ UUID: "io.github.aguilarguisado.siestadeck.switch-account" })
export class SwitchAccount extends SingletonAction<Settings> {
  private visible = new Map<string, Visible>();

  constructor() {
    super();
    accountsService.on("changed", () => {
      for (const v of this.visible.values()) void this.draw(v.action, v.settings);
    });
  }

  override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
    if (!ev.action.isKey()) return;
    this.visible.set(ev.action.id, { action: ev.action, settings: ev.payload.settings });
    await this.draw(ev.action, ev.payload.settings);
  }

  override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
    this.visible.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): Promise<void> {
    if (!ev.action.isKey()) return;
    const v = this.visible.get(ev.action.id);
    if (v) v.settings = ev.payload.settings;
    await this.draw(ev.action, ev.payload.settings);
  }

  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const accts = accountsService.list();
    if (accts.length === 0) {
      await ev.action.showAlert();
      return;
    }
    const mode = ev.payload.settings.mode ?? "next";
    let target: string | undefined;
    if (mode === "specific" && ev.payload.settings.targetSlug) {
      target = ev.payload.settings.targetSlug;
    } else {
      if (accts.length < 2) {
        // Only one saved account — cycle is a no-op. Flash the tile so the
        // user gets feedback instead of a silent press.
        await ev.action.showAlert();
        return;
      }
      const activeIdx = accts.findIndex((a) => a.slug === accountsService.activeSlug);
      target = accts[(activeIdx + 1) % accts.length]?.slug;
    }
    if (!target || target === accountsService.activeSlug) {
      await ev.action.showAlert();
      return;
    }
    try {
      await accountsService.swap(target);
      await ev.action.showOk();
    } catch {
      await ev.action.showAlert();
    }
  }

  override async onSendToPlugin(ev: SendToPluginEvent<{ event?: string }, Settings>): Promise<void> {
    await handleAccountDatasource(ev);
  }

  private async draw(keyAction: KeyAction<Settings>, settings: Settings): Promise<void> {
    const active = accountsService.activeSlug
      ? accountsService.get(accountsService.activeSlug) ?? null
      : null;
    const targetSlug = settings.mode === "specific" ? settings.targetSlug : undefined;
    const target = targetSlug ? accountsService.get(targetSlug) ?? null : null;
    const { svg } = drawSwitchAccount({ active, target, mode: settings.mode });
    await keyAction.setImage(await toImageUri(svg));
  }
}
