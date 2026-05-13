import { renderValueKey } from "../../render/svg.js";
import { colors } from "../../render/theme.js";

export type ModelAccent = { name: string; accent: string };

export function shortName(model: string | null): ModelAccent {
  if (!model) return { name: "--", accent: colors.textDim };
  const m = model.toLowerCase();
  if (m.includes("opus")) return { name: "Opus", accent: "#D0776C" };
  if (m.includes("haiku")) return { name: "Haiku", accent: "#E5A38A" };
  if (m.includes("sonnet")) return { name: "Sonnet", accent: "#F2C744" };
  return { name: model, accent: colors.text };
}

export type ActiveModelDrawInput = {
  activeModel: string | null;
  pinned?: string | null;
};

export function drawActiveModel({ activeModel, pinned }: ActiveModelDrawInput): { svg: string } {
  const source = pinned ?? activeModel ?? null;
  const { name, accent } = shortName(source);
  const svg = renderValueKey({ value: name, label: "model", accent });
  return { svg };
}
