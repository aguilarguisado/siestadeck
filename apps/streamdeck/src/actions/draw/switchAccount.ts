import { renderValueKey } from "../../render/svg.js";

export type DrawAccount = { slug: string; displayName: string; color: string };

export type SwitchAccountDrawInput = {
  active: DrawAccount | null;
  target?: DrawAccount | null;
  mode?: "next" | "specific";
};

export function drawSwitchAccount({ active, target, mode }: SwitchAccountDrawInput): { svg: string } {
  const m = mode ?? "next";
  const tgt = m === "specific" ? target ?? null : null;
  const value = tgt
    ? `→${tgt.displayName.slice(0, 6)}`
    : active
      ? active.displayName.slice(0, 7)
      : "--";
  const svg = renderValueKey({
    value,
    label: tgt ? "switch to" : "swap acct",
    accent: tgt?.color ?? active?.color,
    small: value.length > 5,
  });
  return { svg };
}
