import { renderQuotaMeter, renderSiestaTile } from "../../render/svg.js";
import type { QuotaSnapshot } from "../../services/quota.js";

export const SIESTA_PHRASES = ["siesta", "descansa", "suficiente", "disfruta"] as const;

export type QuotaMeterDrawInput = {
  snap: QuotaSnapshot | null;
  window?: "5h" | "7d";
  now?: number;
  /** Index into SIESTA_PHRASES; advanced by the action while in siesta state. */
  phraseIndex?: number;
  /** Persiana descent progress (0..1); looped 0→1→0 by the action while in siesta. */
  descentProgress?: number;
};

export type QuotaMeterDrawResult = {
  svg: string;
  cooldownSeconds: number;
  resetsInSeconds: number;
  /** True when utilization ≥ 1; the action drives the persiana loop tick. */
  isSiesta: boolean;
};

/**
 * Pure rendering input → output. The action class wraps this with setImage
 * and timers; we test this wrapper-less core directly.
 */
export function drawQuotaMeter({ snap, window, now, phraseIndex, descentProgress }: QuotaMeterDrawInput): QuotaMeterDrawResult {
  const win: "5h" | "7d" = window ?? "5h";
  const data = snap == null ? null : win === "5h" ? snap.fiveHour : snap.sevenDay;
  const nowMs = now ?? Date.now();
  const cooldownSeconds = snap?.cooldownUntil
    ? Math.max(0, Math.ceil((snap.cooldownUntil.getTime() - nowMs) / 1000))
    : 0;
  const resetsInSeconds = data?.resetsAt
    ? Math.max(0, Math.floor((data.resetsAt.getTime() - nowMs) / 1000))
    : 0;
  const utilization = data?.utilization ?? null;
  const isSiesta = utilization != null && utilization >= 1;

  const svg = isSiesta
    ? renderSiestaTile({
        window: win,
        phrase: SIESTA_PHRASES[((phraseIndex ?? 0) % SIESTA_PHRASES.length + SIESTA_PHRASES.length) % SIESTA_PHRASES.length],
        resetsInSeconds: resetsInSeconds > 0 ? resetsInSeconds : null,
        descentProgress,
      })
    : renderQuotaMeter({
        utilization,
        window: win,
        label: win.toUpperCase(),
        cooldownSeconds,
        resetsInSeconds: resetsInSeconds > 0 ? resetsInSeconds : null,
      });
  return { svg, cooldownSeconds, resetsInSeconds, isSiesta };
}
