import { renderAttention } from "../../render/svg.js";
import {
  alarmingSessions,
  type AttentionKeySettings,
  type AttentionSnapshot,
  enabledFromSettings,
} from "../../services/attentionPolicy.js";

const LABEL_MAX = 12;

/** cwd → short tile label (basename, truncated). */
export function cwdLabel(cwd: string | null): string | undefined {
  if (!cwd) return undefined;
  const base = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  if (!base) return undefined;
  return base.length > LABEL_MAX ? base.slice(0, LABEL_MAX - 1) + "…" : base;
}

export type AttentionDrawInput = {
  snap: AttentionSnapshot | null;
  settings: AttentionKeySettings;
  /** Flash frame toggled by the action while flashing; 0 draws the "on" frame. */
  flashFrame: number;
};

export type AttentionDrawResult = { svg: string; flashing: boolean };

export function drawAttention({ snap, settings, flashFrame }: AttentionDrawInput): AttentionDrawResult {
  if (!snap || !snap.hooksInstalled) {
    return { svg: renderAttention({ mode: "setup" }), flashing: false };
  }
  const alarming = alarmingSessions(snap.sessions, enabledFromSettings(settings));
  const worst = alarming[0];
  if (!worst) {
    return { svg: renderAttention({ mode: "quiet" }), flashing: false };
  }
  const flashing = worst.state === "blocked";
  const svg = renderAttention({
    mode: worst.state,
    flashOn: flashing && flashFrame % 2 === 0,
    sessionCount: alarming.length,
    label: cwdLabel(worst.cwd),
  });
  return { svg, flashing };
}
