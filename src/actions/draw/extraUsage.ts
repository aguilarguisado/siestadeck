import { renderValueKey } from "../../render/svg.js";
import type { QuotaSnapshot } from "../../services/quota.js";

export type ExtraUsageDrawInput = {
  snap: QuotaSnapshot | null;
};

export function fmtUsd(n: number): string {
  if (n < 1) return `$${n.toFixed(2)}`;
  if (n >= 100) return `$${Math.round(n)}`;
  const s = n.toFixed(1);
  return `$${s.endsWith(".0") ? s.slice(0, -2) : s}`;
}

export type ExtraUsageDisplay = { value: string; label: string; small: boolean };

/**
 * Pure mapping from a quota snapshot's `extraUsage` block to the on-key value
 * and label. "Extra usage" is Anthropic's pay-as-you-go overage beyond the Max
 * subscription — `usedCredits` is real billed spend, not an estimate.
 */
export function extraUsageDisplay(snap: QuotaSnapshot | null): ExtraUsageDisplay {
  const xu = snap?.extraUsage;
  if (!xu) return { value: "--", label: "extra usage", small: false };
  if (!xu.enabled) return { value: "off", label: "extra usage", small: false };
  if (xu.usedCredits == null) return { value: "--", label: "extra usage", small: false };
  const label =
    xu.monthlyLimit != null ? `extra · ${fmtUsd(xu.monthlyLimit)}` : "extra usage";
  return { value: fmtUsd(xu.usedCredits), label, small: xu.usedCredits >= 100 };
}

export function drawExtraUsage({ snap }: ExtraUsageDrawInput): { svg: string } {
  const { value, label, small } = extraUsageDisplay(snap);
  return { svg: renderValueKey({ value, label, small }) };
}
