import {
  action,
  type KeyAction,
  type KeyDownEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import fs from "node:fs/promises";

import { toImageUri } from "../render/rasterize.js";
import { activeSessionService, type ActiveSessionSnapshot } from "../services/activeSession.js";
import { claudeSettingsJson as SETTINGS_PATH } from "../services/paths.js";
import { drawActiveModel, shortName } from "./draw/activeModel.js";

type Settings = Record<string, never>;
const CYCLE: readonly string[] = ["opus", "haiku", "sonnet"] as const;

async function readSettings(): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

@action({ UUID: "io.github.aguilarguisado.siestadeck.active-model" })
export class ActiveModel extends SingletonAction<Settings> {
  private visible = new Map<string, KeyAction<Settings>>();
  /**
   * Local override pinned when the user presses the key to cycle the model.
   * Wins over the JSONL-derived activeModel until a subsequent session
   * snapshot resolves to the same family (at which point the natural
   * pipeline takes over again).
   */
  private pinned: string | null = null;

  constructor() {
    super();
    activeSessionService.on("snapshot", (snap: ActiveSessionSnapshot) => {
      if (this.pinned && snap.activeModel && shortName(snap.activeModel).name === shortName(this.pinned).name) {
        this.pinned = null;
      }
      for (const a of this.visible.values()) void this.draw(a, snap);
    });
  }

  override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
    if (!ev.action.isKey()) return;
    this.visible.set(ev.action.id, ev.action);
    activeSessionService.acquire(ev.action.id);
    await this.draw(ev.action, activeSessionService.snapshot ?? null);
  }

  override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
    this.visible.delete(ev.action.id);
    activeSessionService.release(ev.action.id);
  }

  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    if (!ev.action.isKey()) return;
    try {
      const settings = await readSettings();
      const current = typeof settings.model === "string" ? settings.model.toLowerCase() : "";
      const currentIdx = CYCLE.findIndex((m) => current.includes(m));
      const nextIdx = currentIdx < 0 ? 0 : (currentIdx + 1) % CYCLE.length;
      const next = CYCLE[nextIdx]!;
      settings.model = next;
      await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf8");
      this.pinned = next;
      const snap = activeSessionService.snapshot ?? null;
      for (const a of this.visible.values()) void this.draw(a, snap);
    } catch {
      await ev.action.showAlert();
    }
  }

  private async draw(keyAction: KeyAction<Settings>, snap: ActiveSessionSnapshot | null): Promise<void> {
    const { svg } = drawActiveModel({ activeModel: snap?.activeModel ?? null, pinned: this.pinned });
    await keyAction.setImage(await toImageUri(svg));
  }
}
