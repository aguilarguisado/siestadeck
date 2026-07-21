export const SIZE = 144;

export const colors = {
  bg: "#0F1115",
  bg5h: "#1A100E",
  bg7d: "#1A100E",
  bgFable: "#1A100E",
  ring: "#1F242C",
  ring5h: "#5C2F2A",
  ring7d: "#5C2F2A",
  ringFable: "#5C2F2A",
  text: "#F4F6FA",
  textDim: "#8A93A1",
  ok: "#3FB950",
  warn: "#F2C744",
  danger: "#E5534B",
  accent: "#D0776C",
  accent7d: "#D0776C",
  accentFable: "#D0776C",
  // Siesta easter egg: utilization >= 1.0 swaps the alarming red ramp for a
  // calm dusk-purple tile background and a soft lavender accent on the
  // account-tile bar / quotaColor ramp.
  siestaBg: "#2A1F3D",
  siestaAccent: "#B794F4",
  // Brand tokens — reserved for branded surfaces (marketplace tile, default
  // key glyph) so the functional ok/warn/danger ramp above stays untouched
  // on quota meters.
  brand: "#B5483A",
  brandOnDark: "#D0776C",
};

export function quotaColor(utilization: number): string {
  if (utilization >= 1) return colors.siestaAccent;
  if (utilization >= 0.85) return colors.danger;
  if (utilization >= 0.6) return colors.warn;
  return colors.ok;
}
