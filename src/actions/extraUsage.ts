import {
  action,
  type KeyAction,
  type KeyDownEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import { toImageUri } from "../render/rasterize.js";
import { quotaRegistry, type QuotaSnapshot } from "../services/quota.js";
import { drawExtraUsage } from "./draw/extraUsage.js";

type Settings = Record<string, never>;

@action({ UUID: "io.github.aguilarguisado.siestadeck.extra-usage" })
export class ExtraUsage extends SingletonAction<Settings> {
  private visible = new Map<string, KeyAction<Settings>>();

  constructor() {
    super();
    quotaRegistry.on("snapshot", (snap: QuotaSnapshot) => {
      if (snap.slug != null) return; // only active-account snapshots
      for (const a of this.visible.values()) void this.draw(a, snap);
    });
  }

  override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
    if (!ev.action.isKey()) return;
    this.visible.set(ev.action.id, ev.action);
    await ev.action.setTitle("");
    await this.draw(ev.action, quotaRegistry.snapshotFor(null) ?? null);
  }

  override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
    this.visible.delete(ev.action.id);
  }

  override onKeyDown(_ev: KeyDownEvent<Settings>): void {
    void quotaRegistry.refresh();
  }

  private async draw(keyAction: KeyAction<Settings>, snap: QuotaSnapshot | null): Promise<void> {
    const { svg } = drawExtraUsage({ snap });
    await keyAction.setImage(await toImageUri(svg));
  }
}
