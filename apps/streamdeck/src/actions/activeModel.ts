import {
  action,
  type KeyAction,
  type KeyDownEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import { toImageUri } from "../render/rasterize.js";
import { drawActiveModel, shortName } from "./draw/activeModel.js";

import { activeSessionService, updateClaudeSettings, type ActiveSessionSnapshot } from "@siesta/core";

type Settings = Record<string, never>;
const CYCLE: readonly string[] = ["opus", "haiku", "sonnet"] as const;

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
      // Derive the step inside the mutator so it reads the same document the
      // write commits — settings.json belongs to Claude Code, and the mutator
      // re-reads, so only `model` changes. Seeded rather than `string | null`:
      // TS narrows a `let` assigned only in a callback to its initializer type.
      let next: string = CYCLE[0]!;
      await updateClaudeSettings((s) => {
        const current = typeof s.model === "string" ? s.model.toLowerCase() : "";
        const currentIdx = CYCLE.findIndex((m) => current.includes(m));
        next = CYCLE[currentIdx < 0 ? 0 : (currentIdx + 1) % CYCLE.length]!;
        s.model = next;
      });
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
